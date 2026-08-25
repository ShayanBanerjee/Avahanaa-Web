/**
 * Avahanaa backend.
 *
 * Someone is standing next to a stranger's car with a problem. They scan a
 * sticker, pick a reason, and tap send. Everything in this file exists to get
 * that from "tap" to "the owner's phone is ringing" in a couple of seconds
 * without ever telling the scanner who the owner is.
 *
 * Two endpoints:
 *
 *   GET  /api/qr/:qrCodeId  -> the vehicle description, and nothing else
 *   POST /api/notify        -> write the alert, push it, return
 *
 * The contract with the app is `docs/backend_contract.md` and
 * `docs/critical_notification_payload_contract.md`. Both are treated here as
 * an API that cannot be changed unilaterally: old app versions stay installed
 * for months, and QR URLs printed on windshields are effectively permanent.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const functionsV1 = require("firebase-functions/v1");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const {
  getFirestore,
  Timestamp,
  FieldValue,
} = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();

setGlobalOptions({
  region: "asia-south1",
  maxInstances: 10,
});

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

/**
 * The reason codes the app renders (`NotificationModel.reasonText`).
 *
 * Adding one here without shipping an app update is safe — the app falls back
 * to a generic title. Removing or renaming one is not.
 */
const REASONS = new Set([
  "blocking_driveway",
  "illegal_parking",
  "blocking_traffic",
  "double_parked",
  "emergency",
  "private_property",
  "other",
]);

/** Titles mirror `FCMService._titleFromReason` so the two sides agree. */
const TITLES = {
  blocking_driveway: "Your vehicle is blocking a driveway",
  illegal_parking: "Parking issue with your vehicle",
  blocking_traffic: "Your vehicle is blocking traffic",
  double_parked: "Your vehicle is double parked",
  emergency: "Emergency at your vehicle",
  private_property: "Your vehicle is on private property",
  other: "Someone needs you at your vehicle",
};

/**
 * The channel the app created for max-importance alerts.
 *
 * Note this is NOT the channel in AndroidManifest's
 * `default_notification_channel_id`, which is still the legacy
 * `congestion_free_channel` (see docs/known_issues.md #1). Sending data-only
 * avoids that mismatch entirely, because the app then places the notification
 * itself on the right channel.
 */
const ALERT_CHANNEL = "avahanaa_critical_alerts_v2";

/**
 * Rate limit per QR code.
 *
 * An unauthenticated endpoint that fires a max-importance alarm on a
 * stranger's phone is an abuse vector. This is the difference between "someone
 * told me my car is blocking a driveway" and "someone rang my phone ninety
 * times at 3am".
 *
 * Deliberately generous on the burst so a genuine emergency can be reported
 * twice, and hard on the hour so harassment is not possible.
 */
const RATE_LIMIT = {
  burst: { max: 3, windowMs: 5 * 60 * 1000 },
  hourly: { max: 8, windowMs: 60 * 60 * 1000 },
};

/** Bounded backoff from the payload contract. */
const RETRY_DELAYS_MS = [0, 2000, 6000, 15000];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cors(req, res) {
  // The scan page is served from the same origin in production, but the
  // emulator serves hosting and functions on different ports, and a partner
  // shop page is a plausible future caller.
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

function fail(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Trims and caps a free-text field.
 *
 * The message is written by an anonymous stranger and rendered on the owner's
 * lock screen, so it is length-capped and stripped of control characters. It is
 * never interpolated into HTML anywhere — the scan page and the app both treat
 * it as text.
 */
function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Consumes one token against both rate-limit windows, in a transaction.
 *
 * Keyed by QR code rather than by IP: the thing being protected is a specific
 * owner's phone, and an attacker changing IP should not reset their budget.
 */
async function consumeRateLimit(qrCodeId) {
  const ref = db.collection("rateLimits").doc(qrCodeId);
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};

    const windows = ["burst", "hourly"];
    const next = {};

    for (const name of windows) {
      const { max, windowMs } = RATE_LIMIT[name];
      const startedAt = data[`${name}StartedAt`] || 0;
      const count = data[`${name}Count`] || 0;

      if (now - startedAt > windowMs) {
        next[`${name}StartedAt`] = now;
        next[`${name}Count`] = 1;
      } else {
        if (count >= max) {
          const retryAfter = Math.ceil((startedAt + windowMs - now) / 1000);
          return { allowed: false, retryAfter, window: name };
        }
        next[`${name}StartedAt`] = startedAt;
        next[`${name}Count`] = count + 1;
      }
    }

    tx.set(ref, { ...next, updatedAt: now }, { merge: true });
    return { allowed: true };
  });
}

/**
 * Resolves a QR to its owner. Returns null for anything a scanner should not
 * be able to distinguish — missing, deactivated, or malformed all look the
 * same from outside, so the endpoint cannot be used to probe which codes exist.
 */
async function resolveQrCode(qrCodeId) {
  if (typeof qrCodeId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(qrCodeId)) {
    return null;
  }
  const snap = await db.collection("qrCodes").doc(qrCodeId).get();
  if (!snap.exists) return null;

  const data = snap.data();
  if (data.isActive !== true) return null;
  if (!data.userId) return null;

  return { id: snap.id, ...data };
}

/**
 * Sends the alert, retrying transient failures with the backoff the contract
 * specifies. `notificationId` never changes between attempts — the app dedupes
 * on it, so a retry that mutated it would ring the owner twice.
 */
async function sendAlert({ token, notificationId, reason, title, body, sentAt, vehicleId, qrCodeId }) {
  const message = {
    token,
    // Data-only on purpose. A `notification` block is auto-displayed by the
    // system in background/terminated state, which bypasses the app's dedupe
    // and its escalating reminders at +3 and +15 minutes — the reminders are
    // the entire urgency guarantee, so this must stay data-only.
    data: {
      type: "vehicle_alert",
      notificationId,
      title,
      body,
      reason,
      sentAt,
      vehicleId: vehicleId || "",
      qrCodeId: qrCodeId || "",
    },
    android: {
      priority: "high",
      // No collapse_key: two distinct alerts must never merge into one.
      notification: { channelId: ALERT_CHANNEL },
      ttl: 60 * 60 * 1000,
    },
    apns: {
      headers: { "apns-priority": "10", "apns-push-type": "background" },
      payload: { aps: { "content-available": 1 } },
    },
  };

  let lastError;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt] > 0) await sleep(RETRY_DELAYS_MS[attempt]);
    try {
      await getMessaging().send(message);
      return { delivered: true, attempts: attempt + 1 };
    } catch (error) {
      lastError = error;
      const code = error?.errorInfo?.code || error?.code || "";
      // A dead token will never succeed; retrying it just delays the response.
      if (
        code.includes("registration-token-not-registered") ||
        code.includes("invalid-argument") ||
        code.includes("invalid-registration-token")
      ) {
        return { delivered: false, permanent: true, code };
      }
      logger.warn("FCM send failed, will retry", {
        notificationId,
        attempt: attempt + 1,
        code,
      });
    }
  }

  return {
    delivered: false,
    permanent: false,
    code: lastError?.errorInfo?.code || "unknown",
  };
}

// ---------------------------------------------------------------------------
// GET /api/qr/:qrCodeId
// ---------------------------------------------------------------------------

/**
 * What the scan page shows before someone commits to sending an alert: enough
 * to confirm they are looking at the right car, and nothing more.
 *
 * The response is deliberately thin. It carries the colour, model and plate
 * that the owner chose to put on the sticker anyway — never the owner's
 * identity, and never the userId.
 */
exports.resolveQr = onRequest(async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "GET") return fail(res, 405, "method_not_allowed", "Use GET.");

  const qrCodeId = (req.path || "").split("/").filter(Boolean).pop();
  const qr = await resolveQrCode(qrCodeId);

  if (!qr) {
    // Same response for missing and deactivated, so the endpoint cannot be
    // used to enumerate which codes are real.
    return fail(res, 404, "not_found", "This code is not active.");
  }

  const vehicle = (qr.metadata && qr.metadata.vehicle) || {};
  res.set("Cache-Control", "public, max-age=60");
  res.json({
    qrCodeId: qr.id,
    vehicle: {
      color: vehicle.color || "",
      carModel: vehicle.carModel || "",
      licensePlate: vehicle.licensePlate || "",
    },
    reasons: [...REASONS],
  });
});

// ---------------------------------------------------------------------------
// POST /api/notify
// ---------------------------------------------------------------------------

/**
 * The alert path.
 *
 * Ordering matters here. The notification document is written *before* the push
 * is attempted, because the app re-syncs unread alerts from Firestore on
 * startup — so even if FCM is down, the owner still sees the alert next time
 * they open the app. Losing the push is recoverable; losing the record is not.
 */
exports.notify = onRequest(async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed", "Use POST.");

  const body = req.body || {};
  const qrCodeId = typeof body.qrCodeId === "string" ? body.qrCodeId.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const message = cleanText(body.message, 280);

  if (!REASONS.has(reason)) {
    return fail(res, 400, "bad_reason", "Unknown reason code.");
  }

  const qr = await resolveQrCode(qrCodeId);
  if (!qr) {
    return fail(res, 404, "not_found", "This code is not active.");
  }

  const limit = await consumeRateLimit(qr.id);
  if (!limit.allowed) {
    res.set("Retry-After", String(limit.retryAfter));
    return fail(
      res,
      429,
      "rate_limited",
      "This vehicle has already been alerted. The owner has been notified.",
    );
  }

  const title = TITLES[reason] || TITLES.other;
  const alertBody =
    message || "Someone scanned your code and needs you at your vehicle.";

  // Firestore generates the ID, and that same ID is what goes over FCM. The
  // app's dedupe, its reminder scheduling and its deep link all key off this
  // being identical in both places.
  const ref = db.collection("notifications").doc();

  await ref.set({
    qrCodeId: qr.id,
    userId: qr.userId,
    vehicleId: qr.vehicleId || "",
    reason,
    message: alertBody,
    title,
    status: "queued",
    read: false,
    sentAt: Timestamp.now(),
    readAt: null,
  });

  logger.info("alert queued", { notificationId: ref.id, reason });

  // Respond the moment the alert is durable, without waiting on FCM.
  //
  // Two reasons. The person who scanned is standing in the street holding
  // their phone, and the contract's retry ladder runs to 23 seconds — nobody
  // waits that long, they assume it failed and send again. And the write is
  // the part that actually matters: the app re-syncs unread alerts from
  // Firestore on startup, so even with FCM completely down the owner still
  // sees this. Losing the push is recoverable; losing the record is not.
  //
  // Delivery, with the full backoff, is `deliverAlert` below.
  res.json({ ok: true, notificationId: ref.id });
});

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * Pushes a queued alert, with the bounded backoff the payload contract
 * specifies.
 *
 * Runs off the request path so the retry ladder (0s, 2s, 6s, 15s) never makes
 * a human wait. Triggered by the document write rather than called directly,
 * which also means an alert written by any other path still gets delivered.
 */
exports.deliverAlert = onDocumentCreated(
  "notifications/{notificationId}",
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const alert = snap.data();
    if (alert.status !== "queued") return;

    const notificationId = event.params.notificationId;

    const userSnap = await db.collection("users").doc(alert.userId).get();
    const user = userSnap.exists ? userSnap.data() : null;
    const token = user ? user.fcmToken : null;
    const enabled = user ? user.notificationsEnabled !== false : false;

    if (!token || !enabled) {
      // Not a failure worth retrying: the owner has notifications off, or has
      // not opened the app since installing. The record still stands and they
      // will see it next time they open the app.
      await snap.ref.update({ status: "undelivered" });
      logger.info("alert not pushed", {
        notificationId,
        reason: !token ? "no_token" : "notifications_disabled",
      });
      return;
    }

    const result = await sendAlert({
      token,
      notificationId,
      reason: alert.reason,
      title: alert.title || TITLES[alert.reason] || TITLES.other,
      body: alert.message,
      sentAt: alert.sentAt.toDate().toISOString(),
      vehicleId: alert.vehicleId,
      qrCodeId: alert.qrCodeId,
    });

    if (result.permanent) {
      // The token is dead. Clear it so every future alert does not pay the
      // full retry ladder discovering the same thing; the app writes a fresh
      // one on next launch.
      await db
        .collection("users")
        .doc(alert.userId)
        .update({ fcmToken: FieldValue.delete() })
        .catch(() => {});
    }

    await snap.ref.update({
      status: result.delivered ? "delivered" : "undelivered",
    });

    logger.info("alert delivery finished", {
      notificationId,
      delivered: result.delivered,
      attempts: result.attempts || null,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /api/lookup?plate=KA01AB1234
// ---------------------------------------------------------------------------

/**
 * Plate → QR code, and nothing else.
 *
 * This exists only because production already has it. The deployed scan page
 * lets someone type a registration number instead of scanning, and it answers
 * that by querying `users` and `vehicles` straight from the browser. Dropping
 * the feature during a security fix would be a silent product change, so it is
 * kept — moved behind the Admin SDK, and made to give up far less.
 *
 * It returns a `qrCodeId` and the same vehicle description `/api/qr` returns.
 * The caller still has to go through `/api/notify`, which enforces the
 * per-QR rate limit, so this is not a way around it.
 *
 * It is nonetheless the weakest point in the system: unlike a sticker, a plate
 * can be guessed. `KA01AB____` is ten thousand tries. The IP budget below
 * makes that slow rather than impossible, which is why the whole endpoint has
 * an off switch — set PLATE_LOOKUP_ENABLED=false to disable it. See
 * DEPLOY.md, "Plate lookup".
 */
const PLATE_LOOKUP_ENABLED =
  (process.env.PLATE_LOOKUP_ENABLED || "true").toLowerCase() !== "false";

/** Tighter than the notify budget: guessing is the threat, not repetition. */
const LOOKUP_RATE_LIMIT = {
  burst: { max: 5, windowMs: 5 * 60 * 1000 },
  hourly: { max: 20, windowMs: 60 * 60 * 1000 },
};

/** Uppercase, strip everything that is not a letter or digit. */
function canonicalisePlate(value) {
  if (typeof value !== "string") return "";
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Same two-window transaction as `consumeRateLimit`, keyed by caller IP.
 *
 * IP is a weak key — it is trivially rotated. It is used here anyway because
 * there is no better identifier before a vehicle is resolved, and it raises
 * the cost of a scripted sweep from free to inconvenient.
 */
async function consumeLookupRateLimit(ip) {
  const ref = db.collection("rateLimits").doc(`lookup_${ip}`);
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const next = {};

    for (const name of ["burst", "hourly"]) {
      const { max, windowMs } = LOOKUP_RATE_LIMIT[name];
      const startedAt = data[`${name}StartedAt`] || 0;
      const count = data[`${name}Count`] || 0;

      if (now - startedAt > windowMs) {
        next[`${name}StartedAt`] = now;
        next[`${name}Count`] = 1;
      } else {
        if (count >= max) {
          return {
            allowed: false,
            retryAfter: Math.ceil((startedAt + windowMs - now) / 1000),
          };
        }
        next[`${name}StartedAt`] = startedAt;
        next[`${name}Count`] = count + 1;
      }
    }

    tx.set(ref, { ...next, updatedAt: now }, { merge: true });
    return { allowed: true };
  });
}

exports.lookup = onRequest(async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "GET") return fail(res, 405, "method_not_allowed", "Use GET.");

  if (!PLATE_LOOKUP_ENABLED) {
    return fail(res, 404, "not_found", "No vehicle matches that number.");
  }

  const plate = canonicalisePlate(req.query.plate || "");
  // Shorter than any real Indian registration; almost certainly a sweep.
  if (plate.length < 6 || plate.length > 16) {
    return fail(res, 404, "not_found", "No vehicle matches that number.");
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.ip ||
    "unknown";

  const limit = await consumeLookupRateLimit(ip);
  if (!limit.allowed) {
    res.set("Retry-After", String(limit.retryAfter));
    return fail(res, 429, "rate_limited", "Too many lookups. Try again shortly.");
  }

  // Resolve through the QR document, never through `users`. `qrCodes.metadata`
  // is the only place a plate is stored that carries no owner identity.
  const snap = await db
    .collection("qrCodes")
    .where("metadata.vehicle.licensePlateCanonical", "==", plate)
    .where("isActive", "==", true)
    .limit(1)
    .get();

  if (snap.empty) {
    return fail(res, 404, "not_found", "No vehicle matches that number.");
  }

  const qr = snap.docs[0];
  const vehicle = (qr.data().metadata && qr.data().metadata.vehicle) || {};

  // No caching. A negative answer that gets cached at the edge turns the rate
  // limit into a suggestion.
  res.set("Cache-Control", "no-store");
  res.json({
    qrCodeId: qr.id,
    vehicle: {
      color: vehicle.color || "",
      carModel: vehicle.carModel || "",
      licensePlate: vehicle.licensePlate || "",
    },
    reasons: [...REASONS],
  });
});

// ---------------------------------------------------------------------------
// notifyOwner — retired
// ---------------------------------------------------------------------------

/**
 * The old callable, kept deployed and refusing.
 *
 * It used to take a `userId` and an `fcmToken` from the browser and push
 * whatever title and body came with them. Deleting it outright would be
 * cleaner, but a scan page cached in someone's browser will keep calling it
 * for as long as its cache lives, and a hard 404 there reads as "the app is
 * broken" rather than "reload the page".
 *
 * Declared v1 in us-central1 deliberately: that is where it already lives, and
 * the callable SDK resolves it by name in the default region. Moving it would
 * break exactly the cached clients this stub exists to catch.
 *
 * Safe to delete once the hosting cache has turned over — a week is plenty.
 * See DEPLOY.md, step 6.
 */
exports.notifyOwner = functionsV1
  .region("us-central1")
  .https.onCall(async () => {
    logger.warn("notifyOwner called after retirement — stale client cached");
    throw new functionsV1.https.HttpsError(
      "failed-precondition",
      "This version of the page is out of date. Please reload and try again.",
    );
  });
