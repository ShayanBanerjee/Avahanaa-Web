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

const crypto = require("node:crypto");

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
const { getAuth } = require("firebase-admin/auth");

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

/**
 * The headline on the owner's lock screen.
 *
 * This string crosses the wire in the data payload and the app displays it
 * verbatim; `FCMService._titleFromReason` is only the fallback for a push from
 * an older sender that carried no title. So these are the server's words, and
 * changing one here changes what owners read.
 *
 * `blocking_driveway` no longer says "driveway". The code is frozen — it is
 * what the app keys its own fallback and its analytics off — but the commonest
 * scan behind it is a two-wheeler boxed in outside a shop, nowhere near a
 * driveway, and the lock screen is the one line the owner reads before
 * deciding whether to get up. "Blocking someone in" is true of a driveway, a
 * gate and a parking bay alike.
 */
const TITLES = {
  blocking_driveway: "Your vehicle is blocking someone in",
  illegal_parking: "Parking issue with your vehicle",
  blocking_traffic: "Your vehicle is blocking traffic",
  double_parked: "Your vehicle is double parked",
  emergency: "Emergency at your vehicle",
  private_property: "Your vehicle is on private property",
  other: "Someone needs you at your vehicle",
  // Not a scan reason — no scan page ever offers it. It exists so a self-test
  // walks exactly the same path as a real alert, including this lookup.
  test: "Test alert — your alarm is working",
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
const ALERT_CHANNEL = "avahanaa_critical_alerts_v3";

/**
 * Where an alert lands when the owner's budget is spent.
 *
 * A real channel, created by the app alongside the alert channel, at default
 * importance: it makes a sound once and sits in the shade. It is deliberately
 * not the alert channel at lower priority — Android channel importance cannot
 * be lowered by the sender after the user has seen the channel, so the two
 * have to be separate channels or the distinction does not survive contact
 * with the system.
 */
const QUIET_CHANNEL = "avahanaa_quiet_notices_v1";

/**
 * What the person at the vehicle is shown when the owner answers.
 *
 * Mirrors `AlertReply` in `lib/models/alert_reply.dart`. The app writes the
 * id; this map is the only place it is turned into words a stranger reads, so
 * the two sides can never disagree about phrasing.
 *
 * An id that is not here means the app is newer than this deploy. That falls
 * back to a plain acknowledgement, which says less than intended and never
 * more — the safe direction.
 */
const REPLY_LABELS = {
  omw_now: "The owner is on their way now",
  omw_5: "The owner is on their way — about 5 minutes",
  omw_15: "The owner is on their way — about 15 minutes",
  cannot_come: "The owner has seen this but can't get there right now",
  seen: "The owner has seen your alert",
};

/** Replies that mean somebody is actually coming. */
const REPLY_ON_THE_WAY = new Set(["omw_now", "omw_5", "omw_15"]);

/**
 * Roughly how long, in minutes. Mirrors `AlertReply.etaMinutes` in the app.
 *
 * Sent so the page can count down rather than show a fixed sentence. Treated
 * as an estimate everywhere and never as a promise — the countdown runs to
 * zero and then says the owner should be arriving, not that they have.
 */
const REPLY_ETA_MINUTES = { omw_now: 1, omw_5: 5, omw_15: 15 };

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
// The alert budget
// ---------------------------------------------------------------------------

/**
 * How many alerts an owner gets, and what happens when they run out.
 *
 * Mirrors `AlertBudget` in the app (`lib/models/alert_wallet.dart`). **This
 * copy is the authoritative one** — the app's exists so the UI can render a
 * balance without a round trip, never so it can decide an outcome. If the two
 * drift, the app shows a wrong number and the server still does the right
 * thing, which is the correct direction for them to drift in.
 *
 * Two rules constrain everything below, and both are the reason this feature
 * is shippable at all:
 *
 * 1. **An emergency is never metered.** [ALWAYS_FREE_REASONS] is checked before
 *    the balance is. Somebody reporting a fire, a crash or an injury is not a
 *    billing event, and an app that put a paywall in front of that would
 *    deserve everything that followed.
 *
 * 2. **Running out never makes an owner uncontactable.** Out of credits, the
 *    alert is still written and still pushed — as a quiet notice rather than
 *    the alarm. What is withheld is the *urgency*: the max-importance channel,
 *    the full-screen intent and the +3/+15 minute reminders. The record always
 *    exists, so the owner sees it the next time they open the app.
 */
const ALERT_BUDGET = {
  freeAlertsPerCycle: 3,
  cycleMs: 30 * 24 * 60 * 60 * 1000,
  creditsPerAd: 1,
  maxEarnedCredits: 12,
};

const ALWAYS_FREE_REASONS = new Set(["emergency"]);

/** How an alert is allowed to arrive. Written to the notification document. */
const TIER_FULL = "full";
const TIER_QUIET = "quiet";

/**
 * Spends one alert against the owner's budget, in a transaction.
 *
 * Order of preference: the subscription, then this cycle's free allowance,
 * then ad-earned credits. Free before earned, because the free allowance
 * expires at the end of the cycle and the earned credits do not — spending the
 * perishable one first is the only version of this that does not quietly
 * destroy something the owner worked for.
 *
 * Returns `{ tier, reasonForTier }`. Never throws for a budget reason: a
 * failure to read the wallet resolves to [TIER_FULL], because the cost of
 * wrongly giving away one alert is a fraction of a paisa and the cost of
 * wrongly silencing one is somebody's windscreen.
 */

/**
 * Whether the owner is inside their quiet-hours window right now.
 *
 * Quiet hours never silence an alert. They force the *delivery tier* down, so
 * a non-emergency arriving at 3am lands on the quiet channel with the phone's
 * ordinary tone and no escalating reminders — still delivered, still written,
 * still answerable. Suppressing the alert outright would mean a vehicle being
 * towed at 3am goes unreported because of a preference set months ago.
 *
 * Emergencies never reach this function: `spendAlertBudget` returns before it.
 *
 * **Timezone.** The backend runs in UTC and Firestore stores no locale, so the
 * app writes `timezoneOffsetMinutes` on the user document at launch and this
 * adds it. India has no DST, and for anywhere that does, the offset is
 * refreshed every time the app opens — stale by at most one launch, which
 * shifts a boundary by an hour and never fails open into silence.
 *
 * A missing offset means UTC, which is the wrong hour for an Indian user but
 * still a bounded, self-correcting error rather than a dropped alert.
 */
function isWithinQuietHours(user) {
  const quiet = user.quietHours;
  if (!quiet || quiet.enabled !== true) return false;

  const start = Number(quiet.startMinute);
  const end = Number(quiet.endMinute);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  // A zero-length window reads as off, never as all day — the opposite reading
  // would turn the product off from a slip of a time picker.
  if (start === end) return false;

  const offset = Number(user.timezoneOffsetMinutes) || 0;
  const local = new Date(Date.now() + offset * 60 * 1000);
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();

  // The window that matters crosses midnight, so it is two ranges, not one.
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
}

async function spendAlertBudget(userId, reason) {
  if (ALWAYS_FREE_REASONS.has(reason)) {
    // Not metered — but still counted. `lifetimeAlertsReceived` is the owner's
    // own history, and a count that silently omitted the emergencies would be
    // wrong about exactly the alerts that mattered most.
    //
    // Deliberately fire-and-forget: an emergency must never wait on, or be
    // affected by, a bookkeeping write.
    db.collection("users").doc(userId)
      .update({ lifetimeAlertsReceived: FieldValue.increment(1) })
      .catch((error) => {
        logger.warn("could not count an emergency alert", {
          userId,
          error: String(error),
        });
      });
    return { tier: TIER_FULL, reasonForTier: "emergency" };
  }

  const ref = db.collection("users").doc(userId);
  const now = Date.now();

  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        return { tier: TIER_FULL, reasonForTier: "no_user_doc" };
      }
      const user = snap.data();

      const updates = {
        lifetimeAlertsReceived: FieldValue.increment(1),
      };

      // Checked before the plan and before the balance, and applied to
      // subscribers too: somebody paying for unlimited alerts still asked not
      // to be woken at 3am, and honouring the meter over their own preference
      // would be the wrong way round.
      //
      // Still spends from the budget. The alert was delivered, the function
      // ran, and the push was sent — quiet hours change how loud it is, not
      // whether it happened. Making it free would also give anybody a way to
      // find out when an owner sleeps by watching their own balance.
      const quiet = isWithinQuietHours(user);

      // Subscribed and unexpired: nothing is metered and nothing is counted.
      const expiresAt = user.planExpiresAt;
      const expiresMs = expiresAt && typeof expiresAt.toMillis === "function"
        ? expiresAt.toMillis()
        : 0;
      if (user.plan && user.plan !== "free" && expiresMs > now) {
        tx.update(ref, updates);
        return quiet
          ? { tier: TIER_QUIET, reasonForTier: "quiet_hours" }
          : { tier: TIER_FULL, reasonForTier: "subscription" };
      }

      // Roll the cycle forward if it has lapsed. Done here rather than on a
      // schedule because a scheduled job over every user is a lot of reads to
      // reset a counter that only matters at the moment it is read.
      const cycleStartedMs =
        user.cycleStartedAt && typeof user.cycleStartedAt.toMillis === "function"
          ? user.cycleStartedAt.toMillis()
          : 0;
      let freeUsed = Number(user.freeAlertsUsed) || 0;

      if (!cycleStartedMs || now - cycleStartedMs >= ALERT_BUDGET.cycleMs) {
        freeUsed = 0;
        updates.cycleStartedAt = Timestamp.fromMillis(now);
      }

      if (freeUsed < ALERT_BUDGET.freeAlertsPerCycle) {
        updates.freeAlertsUsed = freeUsed + 1;
        tx.update(ref, updates);
        return quiet
          ? { tier: TIER_QUIET, reasonForTier: "quiet_hours" }
          : { tier: TIER_FULL, reasonForTier: "free_allowance" };
      }

      const credits = Number(user.alertCredits) || 0;
      if (credits > 0) {
        updates.freeAlertsUsed = freeUsed;
        updates.alertCredits = credits - 1;
        tx.update(ref, updates);
        return quiet
          ? { tier: TIER_QUIET, reasonForTier: "quiet_hours" }
          : { tier: TIER_FULL, reasonForTier: "earned_credit" };
      }

      updates.freeAlertsUsed = freeUsed;
      tx.update(ref, updates);
      return { tier: TIER_QUIET, reasonForTier: "out_of_credits" };
    });
  } catch (error) {
    // Deliberately generous. See the doc comment: the failure mode of this
    // function must be "the alert got through" and never "the alert did not".
    logger.error("alert budget transaction failed; delivering at full tier", {
      userId,
      error: String(error),
    });
    return { tier: TIER_FULL, reasonForTier: "budget_error" };
  }
}

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
  return consumeBudgetedRateLimit(qrCodeId, RATE_LIMIT);
}

/**
 * The same two-window budget, against any bucket and any limits.
 *
 * Extracted when the self-test endpoint needed its own budget. The alternative
 * — a third copy of the transaction — is how the notify limiter and the lookup
 * limiter already came to disagree about the shape of their stored documents.
 */
async function consumeBudgetedRateLimit(bucket, limits) {
  const ref = db.collection("rateLimits").doc(bucket);
  const now = Date.now();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};

    const windows = ["burst", "hourly"];
    const next = {};

    for (const name of windows) {
      const { max, windowMs } = limits[name];
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

/**
 * The scan's coordinates, coarsened, or null.
 *
 * Optional on every path — an alert without a location is a perfectly good
 * alert, and the scan page must never block on a permission prompt.
 *
 * **Rounded to three decimals, deliberately.** That is about 110 m at this
 * latitude: enough for an owner to tell which of their parked cars this is and
 * roughly where, and not enough to follow a person. The raw fix is never
 * stored. The scanner is an anonymous stranger doing somebody a favour, and
 * the fact that this product refuses to identify *them* either is the reason
 * they are willing to press the button at all.
 *
 * The accuracy radius is kept because a 2 km GPS fix and a 20 m one mean very
 * different things to somebody deciding whether to walk outside, and the app
 * says which it got.
 */
function sanitiseLocation(raw) {
  if (!raw || typeof raw !== "object") return null;

  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  // (0, 0) is in the Atlantic. It is what a broken client sends, never a fix.
  if (lat === 0 && lng === 0) return null;

  const accuracy = Number(raw.accuracyM);

  return {
    lat: Math.round(lat * 1000) / 1000,
    lng: Math.round(lng * 1000) / 1000,
    accuracyM:
      Number.isFinite(accuracy) && accuracy > 0
        ? Math.min(Math.round(accuracy), 100000)
        : null,
    capturedAt: Timestamp.now(),
  };
}

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
async function sendAlert({
  token,
  notificationId,
  reason,
  title,
  body,
  sentAt,
  vehicleId,
  qrCodeId,
  tier = TIER_FULL,
}) {
  const quiet = tier === TIER_QUIET;

  const message = {
    token,
    // Data-only on purpose. A `notification` block is auto-displayed by the
    // system in background/terminated state, which bypasses the app's dedupe
    // and its escalating reminders at +3 and +15 minutes — the reminders are
    // the entire urgency guarantee, so this must stay data-only.
    data: {
      type: "vehicle_alert",
      notificationId,
      // The quiet tier keeps the alert's own words. Replacing them with
      // "you are out of credits" would hide the thing the owner actually
      // needs to know behind an upsell, and that is the version of this
      // feature that gets an app pulled from the store. The app adds the
      // restore prompt as a second line; it never replaces the first.
      title,
      body,
      reason,
      sentAt,
      vehicleId: vehicleId || "",
      qrCodeId: qrCodeId || "",
      // `full` or `quiet`. The app reads this to choose a channel and to
      // decide whether to schedule the escalating reminders. Absent on pushes
      // from older deploys, and the app treats absent as `full` — an old
      // sender must never accidentally downgrade an alert.
      tier,
    },
    android: {
      // Quiet still means high: `normal` priority lets Doze hold a push until
      // the next maintenance window, which on an idle phone overnight can be
      // hours. The point of the tier is that it does not *alarm*, not that it
      // arrives late.
      priority: "high",
      // No collapse_key: two distinct alerts must never merge into one.
      notification: { channelId: quiet ? QUIET_CHANNEL : ALERT_CHANNEL },
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
  const location = sanitiseLocation(body.location);

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

  // Spend one alert against the owner's budget. The scanner is never told the
  // result — not in this response, not in a status code, not in a timing
  // difference — because the state of a stranger's subscription is none of
  // their business, and "this owner is out of credits" is exactly the signal
  // somebody with bad intentions would want.
  const budget = await spendAlertBudget(qr.userId, reason);

  // Firestore generates the ID, and that same ID is what goes over FCM. The
  // app's dedupe, its reminder scheduling and its deep link all key off this
  // being identical in both places.
  const ref = db.collection("notifications").doc();

  // The scan page needs to come back and ask whether the owner replied, but it
  // has no account and Firestore refuses it outright. So it gets a capability:
  // an unguessable token, handed over once, that only unlocks this one alert's
  // reply status. Without it `/api/status` would be an enumeration oracle over
  // every notification ever sent.
  const statusToken = crypto.randomBytes(24).toString("base64url");

  await ref.set({
    qrCodeId: qr.id,
    userId: qr.userId,
    vehicleId: qr.vehicleId || "",
    reason,
    message: alertBody,
    title,
    status: "queued",
    // How this one is allowed to arrive. Recorded on the document rather than
    // recomputed at delivery time so that a retry, a replay, or a future
    // reader of this collection all see the same decision that was actually
    // made — and so the budget is charged exactly once, here.
    deliveryTier: budget.tier,
    deliveryTierReason: budget.reasonForTier,
    read: false,
    sentAt: Timestamp.now(),
    readAt: null,
    // Absent unless the person scanning chose to share it. Written as `null`
    // rather than omitted so the field's meaning is "asked and declined or
    // unavailable" rather than "this document predates the feature".
    location,
    statusToken,
    acknowledgedAt: null,
    acknowledgementEta: "",
  });

  logger.info("alert queued", {
    notificationId: ref.id,
    reason,
    tier: budget.tier,
    tierReason: budget.reasonForTier,
  });

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
  res.json({ ok: true, notificationId: ref.id, statusToken });
});

// ---------------------------------------------------------------------------
// GET /api/status?id=...&t=...
// ---------------------------------------------------------------------------

/**
 * Has the owner answered yet?
 *
 * The other half of the product. Someone is standing next to a stranger's car
 * deciding how annoyed to be; "the owner is on their way, about 5 minutes" is
 * the thing that ends that. It costs nothing to send and it is the entire
 * reason the alert was worth delivering fast.
 *
 * Answers only two things — whether a reply exists and what it says — and
 * requires the capability token minted at notify time, so it cannot be walked.
 * Nothing about the owner is in the response: not a name, not a token, not
 * even the userId.
 */
exports.status = onRequest(async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "GET") return fail(res, 405, "method_not_allowed", "Use GET.");

  const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
  const token = typeof req.query.t === "string" ? req.query.t.trim() : "";
  if (!id || !token) {
    return fail(res, 404, "not_found", "Unknown alert.");
  }

  const snap = await db.collection("notifications").doc(id).get();
  if (!snap.exists) {
    return fail(res, 404, "not_found", "Unknown alert.");
  }

  const alert = snap.data();
  const expected = alert.statusToken || "";

  // Constant-time compare. The tokens are the same length by construction, and
  // an early-exit compare on a pollable endpoint is a byte-at-a-time oracle.
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    // Same answer as a missing alert, so a wrong token cannot confirm that the
    // id was real.
    return fail(res, 404, "not_found", "Unknown alert.");
  }

  const replyId = alert.acknowledgementEta || "";
  const acknowledged = Boolean(alert.acknowledgedAt);

  // Never cached. The whole value of this endpoint is that the answer changes.
  res.set("Cache-Control", "no-store");
  res.json({
    delivered: alert.status === "delivered",
    acknowledged,
    reply: acknowledged
      ? {
          id: replyId,
          label: REPLY_LABELS[replyId] || REPLY_LABELS.seen,
          onTheWay: REPLY_ON_THE_WAY.has(replyId),
          etaMinutes: REPLY_ETA_MINUTES[replyId] || null,
          at: alert.acknowledgedAt.toDate().toISOString(),
        }
      : null,
  });
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
      // Documents written before the budget shipped have no tier. They are
      // delivered at full strength, which is both the old behaviour and the
      // safe direction.
      tier: alert.deliveryTier || TIER_FULL,
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

// ---------------------------------------------------------------------------
// Billing — subscriptions
// ---------------------------------------------------------------------------

/**
 * Subscription tiers, and how long each one buys.
 *
 * Mirrors `AvahanaaPlan` in the app. The product ids are what Google Play
 * knows these by and are permanent — an owner who subscribed under
 * `avahanaa_plus_weekly` renews against that id for as long as they stay
 * subscribed, so a rename here silently un-subscribes real people.
 */
const SUBSCRIPTION_PRODUCTS = {
  avahanaa_plus_weekly: "weekly",
  avahanaa_plus_monthly: "monthly",
  avahanaa_plus_yearly: "yearly",
};

const ANDROID_PACKAGE_NAME =
  process.env.ANDROID_PACKAGE_NAME || "com.avahanaa.congestion_free";

/**
 * Verifies the caller's Firebase ID token.
 *
 * Returns the uid, or null. Deliberately quiet about *why* it failed — an
 * endpoint that distinguishes "expired" from "forged" is an endpoint that
 * helps somebody forge one.
 */
async function authenticate(req) {
  const header = req.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  try {
    const decoded = await getAuth().verifyIdToken(header.slice(7).trim());
    return decoded.uid || null;
  } catch (error) {
    logger.info("Rejected an ID token", { error: String(error) });
    return null;
  }
}

/**
 * Asks Google what a purchase token actually bought.
 *
 * Uses the Play Developer API's `subscriptionsv2` endpoint through the
 * function's own service account, which must be granted "View financial data"
 * on the app in the Play Console. Without that grant this returns 401 and every
 * purchase fails to activate — the single most common way this feature is
 * broken in production, so the error is logged loudly.
 */
async function fetchPlaySubscription(purchaseToken) {
  const { token } = await getAccessToken();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(ANDROID_PACKAGE_NAME)}/purchases/subscriptionsv2/tokens/` +
    `${encodeURIComponent(purchaseToken)}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    logger.error("Play Developer API rejected the lookup", {
      status: response.status,
      body: text.slice(0, 500),
    });
    return null;
  }

  return response.json();
}

/**
 * A Google access token for the Play Developer API.
 *
 * The function's default service account already carries an identity; all that
 * is needed is a token scoped to androidpublisher. Fetched through the metadata
 * server, which is only reachable from inside the runtime — locally this fails
 * and the emulator path below short-circuits before reaching it.
 */
async function getAccessToken() {
  const { GoogleAuth } = require("google-auth-library");
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();
  return { token: typeof accessToken === "string" ? accessToken : accessToken.token };
}

/**
 * POST /api/billing/verify
 *
 * The app hands over a Play purchase token; this decides whether it is real and
 * writes the grant. The app never writes `plan` or `planExpiresAt` itself — the
 * Firestore rules forbid it — so this endpoint is the only way to become a
 * subscriber, which is the point.
 */
exports.billingVerify = onRequest(async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return fail(res, 405, "method_not_allowed", "Use POST.");
  }

  const uid = await authenticate(req);
  if (!uid) return fail(res, 401, "unauthenticated", "Sign in first.");

  const body = req.body || {};
  const productId = cleanText(body.productId, 100);
  const purchaseToken = cleanText(body.purchaseToken, 4096);

  const plan = SUBSCRIPTION_PRODUCTS[productId];
  if (!plan) return fail(res, 400, "bad_product", "Unknown product.");
  if (!purchaseToken) {
    return fail(res, 400, "bad_request", "Missing purchaseToken.");
  }

  let subscription;
  try {
    subscription = await fetchPlaySubscription(purchaseToken);
  } catch (error) {
    logger.error("Play verification threw", { error: String(error) });
    return fail(res, 503, "verify_unavailable", "Could not reach Google Play.");
  }

  if (!subscription) {
    return fail(res, 402, "not_verified", "Google Play did not recognise that purchase.");
  }

  // `SUBSCRIPTION_STATE_ACTIVE` and `..._IN_GRACE_PERIOD` both mean the person
  // should have service. Grace period is somebody whose card failed and who
  // Google is still retrying — cutting them off instantly is how a payment
  // hiccup becomes a cancelled subscription.
  const state = subscription.subscriptionState || "";
  const entitled =
    state === "SUBSCRIPTION_STATE_ACTIVE" ||
    state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD";

  if (!entitled) {
    logger.info("Purchase verified but not entitled", { uid, state });
    return fail(res, 402, "not_active", "That subscription is not active.");
  }

  const line = (subscription.lineItems || [])[0] || {};
  const expiryIso = line.expiryTime || subscription.expiryTime;
  const expiry = expiryIso ? new Date(expiryIso) : null;
  if (!expiry || Number.isNaN(expiry.getTime())) {
    return fail(res, 502, "bad_expiry", "Google Play returned no expiry.");
  }

  // The purchase token is claimed by exactly one account. Without this, one
  // subscription could be shared across every account that could be handed the
  // same token.
  const claimRef = db.collection("purchaseTokens").doc(
    crypto.createHash("sha256").update(purchaseToken).digest("hex"),
  );

  try {
    await db.runTransaction(async (tx) => {
      const claim = await tx.get(claimRef);
      if (claim.exists && claim.data().userId !== uid) {
        throw new Error("token_claimed");
      }

      tx.set(claimRef, {
        userId: uid,
        productId,
        updatedAt: Timestamp.now(),
      }, { merge: true });

      tx.set(
        db.collection("users").doc(uid),
        {
          plan,
          planProductId: productId,
          planExpiresAt: Timestamp.fromDate(expiry),
          planUpdatedAt: Timestamp.now(),
        },
        { merge: true },
      );
    });
  } catch (error) {
    if (String(error).includes("token_claimed")) {
      return fail(res, 409, "already_claimed", "That purchase belongs to another account.");
    }
    logger.error("Could not write the subscription grant", { error: String(error) });
    return fail(res, 500, "grant_failed", "Could not activate that plan.");
  }

  logger.info("subscription activated", { uid, plan, expiry: expiry.toISOString() });
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, plan, expiresAt: expiry.toISOString() });
});

/**
 * Real-Time Developer Notifications, from Play via Pub/Sub.
 *
 * The renewal path. A subscription that renews at 3am has to extend on a phone
 * that is switched off, so it cannot go through the app — Google publishes the
 * event and this consumes it.
 *
 * Every notification is treated the same way: take the purchase token it names,
 * ask Play what the current state is, and rewrite the grant from that answer.
 * Trusting the notification's own type field would mean handling a dozen event
 * types correctly and getting the out-of-order ones wrong; re-reading the truth
 * is one code path and is always right.
 *
 * Subscribe this to the topic configured under Play Console → Monetisation
 * setup → Real-time developer notifications.
 */
exports.playNotifications = functionsV1
  .region("asia-south1")
  .pubsub.topic("play-billing-rtdn")
  .onPublish(async (message) => {
    let payload;
    try {
      payload = JSON.parse(
        Buffer.from(message.data, "base64").toString("utf8"),
      );
    } catch (error) {
      logger.error("Unparseable RTDN payload", { error: String(error) });
      return;
    }

    const notification = payload.subscriptionNotification;
    if (!notification || !notification.purchaseToken) return;

    const purchaseToken = notification.purchaseToken;
    const claimRef = db.collection("purchaseTokens").doc(
      crypto.createHash("sha256").update(purchaseToken).digest("hex"),
    );

    const claim = await claimRef.get();
    if (!claim.exists) {
      // A renewal for a token this backend never granted. Normal right after a
      // migration, and nothing useful can be done with it.
      logger.info("RTDN for an unknown purchase token");
      return;
    }

    const uid = claim.data().userId;
    const subscription = await fetchPlaySubscription(purchaseToken).catch(
      (error) => {
        logger.error("RTDN lookup failed", { error: String(error) });
        return null;
      },
    );

    if (!subscription) return;

    const state = subscription.subscriptionState || "";
    const entitled =
      state === "SUBSCRIPTION_STATE_ACTIVE" ||
      state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD";

    const line = (subscription.lineItems || [])[0] || {};
    const expiryIso = line.expiryTime || subscription.expiryTime;
    const expiry = expiryIso ? new Date(expiryIso) : null;

    if (entitled && expiry && !Number.isNaN(expiry.getTime())) {
      await db.collection("users").doc(uid).set(
        {
          plan: SUBSCRIPTION_PRODUCTS[claim.data().productId] || "monthly",
          planExpiresAt: Timestamp.fromDate(expiry),
          planUpdatedAt: Timestamp.now(),
        },
        { merge: true },
      );
      logger.info("subscription renewed", { uid, expiry: expiry.toISOString() });
      return;
    }

    // Cancelled, expired, revoked, or on hold. The plan drops to free — but
    // note that `planExpiresAt` is left alone on a plain cancellation, because
    // Play keeps somebody entitled until the end of the period they paid for.
    // Only a revocation (a refund) cuts service immediately.
    const revoked = state === "SUBSCRIPTION_STATE_EXPIRED" ||
      notification.notificationType === 12; // SUBSCRIPTION_REVOKED

    await db.collection("users").doc(uid).set(
      {
        plan: "free",
        planUpdatedAt: Timestamp.now(),
        ...(revoked ? { planExpiresAt: Timestamp.now() } : {}),
      },
      { merge: true },
    );
    logger.info("subscription ended", { uid, state });
  });

// ---------------------------------------------------------------------------
// Wallet — earning credits
// ---------------------------------------------------------------------------

/**
 * Where AdMob tells us an ad was actually watched.
 *
 * The app cannot be trusted to say this. It runs on the user's phone, and a
 * phone can be made to claim anything; a client-granted credit is a credit
 * anyone can mint. So the balance moves here and nowhere else, on a callback
 * Google makes directly to this endpoint with an ECDSA signature over the
 * query string.
 *
 * Three things have to hold before a credit is written:
 *
 * 1. The signature verifies against one of Google's published reward keys.
 * 2. `transaction_id` has not been seen before — Google retries this callback,
 *    and a retry that paid out twice would be a free credit generator.
 * 3. `user_id` names a real user document.
 *
 * Configure the callback URL in the AdMob console against the rewarded ad unit:
 * `https://avahanaa.com/api/wallet/ssv`. See docs in the app repo,
 * `docs/monetization.md`.
 */

/** Google's rotating verifier keys, cached between invocations. */
const SSV_KEYS_URL = "https://gstatic.com/admob/reward/verifier-keys.json";
let ssvKeyCache = { fetchedAt: 0, keys: new Map() };

async function getSsvKey(keyId) {
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const fresh = Date.now() - ssvKeyCache.fetchedAt < ONE_DAY;

  if (fresh && ssvKeyCache.keys.has(String(keyId))) {
    return ssvKeyCache.keys.get(String(keyId));
  }

  // Refetch on a miss even when the cache is fresh: Google rotates keys, and a
  // brand-new key id arriving before the daily refresh would otherwise reject
  // every legitimate callback for up to a day.
  const response = await fetch(SSV_KEYS_URL);
  if (!response.ok) {
    throw new Error(`verifier-keys fetch failed: ${response.status}`);
  }
  const body = await response.json();
  const keys = new Map();
  for (const key of body.keys || []) {
    keys.set(String(key.keyId), key.pem);
  }
  ssvKeyCache = { fetchedAt: Date.now(), keys };
  return keys.get(String(keyId));
}

/**
 * Verifies AdMob's signature.
 *
 * The signed content is the raw query string from the first parameter up to
 * but **not including** `&signature=`. It has to be taken from the raw URL
 * rather than rebuilt from parsed parameters — re-encoding changes the bytes
 * and every signature fails, which is the classic way to spend an afternoon on
 * this endpoint.
 */
async function verifySsvSignature(rawQuery) {
  const signatureIndex = rawQuery.indexOf("&signature=");
  if (signatureIndex === -1) return false;

  const signedContent = rawQuery.slice(0, signatureIndex);
  const params = new URLSearchParams(rawQuery);
  const signature = params.get("signature");
  const keyId = params.get("key_id");
  if (!signature || !keyId) return false;

  const pem = await getSsvKey(keyId);
  if (!pem) {
    logger.warn("Unknown AdMob SSV key id", { keyId });
    return false;
  }

  return crypto
    .createVerify("SHA256")
    .update(signedContent)
    .verify(pem, Buffer.from(signature, "base64url"));
}

exports.adSsv = onRequest(async (req, res) => {
  // No CORS: this is called by Google's servers, never by a browser.
  if (req.method !== "GET") {
    return fail(res, 405, "method_not_allowed", "Use GET.");
  }

  const rawQuery = (req.originalUrl || req.url || "").split("?")[1] || "";

  let valid = false;
  try {
    valid = await verifySsvSignature(rawQuery);
  } catch (error) {
    logger.error("SSV verification threw", { error: String(error) });
    // 500 rather than 403: Google retries a 5xx, and a transient key-fetch
    // failure should cost a retry, not the user's credit.
    return fail(res, 500, "verify_failed", "Could not verify.");
  }

  if (!valid) {
    logger.warn("Rejected an unsigned or badly signed SSV callback");
    return fail(res, 403, "bad_signature", "Signature did not verify.");
  }

  const params = new URLSearchParams(rawQuery);
  const userId = params.get("user_id") || "";
  const customData = params.get("custom_data") || "";
  const transactionId = params.get("transaction_id") || "";

  if (!userId || !transactionId) {
    return fail(res, 400, "bad_request", "Missing user_id or transaction_id.");
  }

  const rewardRef = db.collection("adRewards").doc(transactionId);
  const userRef = db.collection("users").doc(userId);

  try {
    await db.runTransaction(async (tx) => {
      const [rewardSnap, userSnap] = await Promise.all([
        tx.get(rewardRef),
        tx.get(userRef),
      ]);

      // Google retries this callback on any non-2xx, and sometimes on a 2xx it
      // did not hear. The transaction id is the idempotency key.
      if (rewardSnap.exists) return;
      if (!userSnap.exists) {
        throw new Error(`unknown user ${userId}`);
      }

      const user = userSnap.data();
      const credits = Number(user.alertCredits) || 0;
      const granted = Math.min(
        ALERT_BUDGET.creditsPerAd,
        Math.max(0, ALERT_BUDGET.maxEarnedCredits - credits),
      );

      // The reward document is written whether or not a credit was granted, so
      // that a capped user's retries settle instead of looping — and so the
      // app's claim poll can tell "settled, but you are at the cap" from "not
      // settled yet".
      tx.set(rewardRef, {
        userId,
        customData,
        granted,
        credits: credits + granted,
        createdAt: Timestamp.now(),
      });

      if (granted > 0) {
        tx.update(userRef, {
          alertCredits: credits + granted,
          lifetimeAdsWatched: FieldValue.increment(1),
        });
      }
    });
  } catch (error) {
    logger.error("Could not settle an ad reward", {
      transactionId,
      error: String(error),
    });
    return fail(res, 500, "settle_failed", "Could not record the reward.");
  }

  res.status(200).send("");
});

/**
 * POST /api/wallet/claim — "has my credit landed yet?"
 *
 * Purely a read. The app calls it in a short retry loop right after an ad
 * finishes, because Google's callback usually arrives within a second but not
 * always, and a balance that ticks up while somebody is still looking at the
 * screen is the difference between a mechanism that feels real and one that
 * feels broken.
 *
 * Answers `settled: false` rather than an error while the callback is still in
 * flight — nothing has gone wrong, and the credit lands either way.
 */
exports.walletClaim = onRequest(async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return fail(res, 405, "method_not_allowed", "Use POST.");
  }

  const uid = await authenticate(req);
  if (!uid) return fail(res, 401, "unauthenticated", "Sign in first.");

  const rewardToken = cleanText((req.body || {}).rewardToken, 64);
  if (!rewardToken) {
    return fail(res, 400, "bad_request", "Missing rewardToken.");
  }

  const [rewards, userSnap] = await Promise.all([
    db
      .collection("adRewards")
      .where("userId", "==", uid)
      .where("customData", "==", rewardToken)
      .limit(1)
      .get(),
    db.collection("users").doc(uid).get(),
  ]);

  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    settled: !rewards.empty,
    credits: userSnap.exists ? Number(userSnap.data().alertCredits) || 0 : 0,
  });
});


// ---------------------------------------------------------------------------
// POST /api/alerts/test
// ---------------------------------------------------------------------------

/**
 * Fire a real alert at yourself.
 *
 * The whole product is a promise that a phone in a pocket will make a noise
 * loud enough to move somebody. Until this endpoint existed, the only way to
 * find out whether that promise held on *your* phone — with your Do Not
 * Disturb settings, your battery optimiser, your notification permissions,
 * your particular manufacturer's opinion about background apps — was to have
 * a stranger scan your windscreen for real.
 *
 * Xiaomi, Oppo, Vivo and Samsung all ship aggressive background killers that
 * silently break FCM delivery, and there is no API that reports it. The only
 * detector is an alert the owner asked for and can tell you did not arrive.
 *
 * So this walks the entire live path — the same document write, the same
 * `deliverAlert` trigger, the same data-only push, the same channel, the same
 * full-screen intent. Nothing is stubbed. The only differences are that it
 * requires the caller to be signed in as the owner, and that it is never
 * metered: charging somebody a credit to check that the thing they are paying
 * for works would be indefensible.
 */

/** One test a minute, ten a day. Enough to debug a phone, not to spam one. */
const SELF_TEST_LIMIT = {
  burst: { max: 1, windowMs: 60 * 1000 },
  hourly: { max: 10, windowMs: 24 * 60 * 60 * 1000 },
};

exports.selfTest = onRequest(async (req, res) => {
  if (cors(req, res)) return;
  if (req.method !== "POST") {
    return fail(res, 405, "method_not_allowed", "Use POST.");
  }

  const uid = await authenticate(req);
  if (!uid) return fail(res, 401, "unauthenticated", "Sign in first.");

  const limit = await consumeBudgetedRateLimit(
    `selftest:${uid}`,
    SELF_TEST_LIMIT,
  );
  if (!limit.allowed) {
    res.set("Retry-After", String(limit.retryAfter));
    return fail(
      res,
      429,
      "rate_limited",
      "You just sent a test. Give it a minute.",
    );
  }

  const vehicleId = cleanText((req.body || {}).vehicleId, 128);

  const ref = db.collection("notifications").doc();
  await ref.set({
    // No qrCodeId: this alert did not come from a scan, and inventing one would
    // put a fake row in the QR's own rate-limit bucket.
    qrCodeId: "",
    userId: uid,
    vehicleId,
    reason: "test",
    title: TITLES.test,
    message:
      "This is the test you asked for. A real alert looks and sounds exactly " +
      "like this one.",
    status: "queued",
    // Always full strength. The point of the test is the alarm.
    deliveryTier: TIER_FULL,
    deliveryTierReason: "self_test",
    isTest: true,
    read: false,
    sentAt: Timestamp.now(),
    readAt: null,
    // No statusToken: there is nobody standing at the vehicle to poll for a
    // reply, and minting a capability nobody holds is a capability that leaks.
    statusToken: null,
    acknowledgedAt: null,
    acknowledgementEta: "",
  });

  logger.info("self-test alert queued", { uid, notificationId: ref.id });
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, notificationId: ref.id });
});

exports.notifyOwner = functionsV1
  .region("us-central1")
  .https.onCall(async () => {
    logger.warn("notifyOwner called after retirement — stale client cached");
    throw new functionsV1.https.HttpsError(
      "failed-precondition",
      "This version of the page is out of date. Please reload and try again.",
    );
  });
