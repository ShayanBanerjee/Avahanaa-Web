# Avahanaa – Vehicle QR Notification Website

Avahanaa lets anyone discreetly reach a vehicle owner by scanning a QR code or
entering the number plate printed on the sticker. A passer-by picks a reason;
the backend resolves the owner with its own credentials and delivers a push
notification to the owner's Flutter app over FCM. The scan page never learns who
the owner is — it is given a colour, a model and a plate, the three things
already visible through the windscreen.

The web experience is one React bundle rendered from `index.html`, styled with
`theme.css` — the web expression of the app's design system in
`lib/theme/app_theme.dart`, tokens and all, in both a light and a night palette.

This repository relies entirely on Firebase services — Firestore for contact
storage, Cloud Functions for lookup and push delivery — so no separate
Node/Express backend is required.

## Features

- **Home**, **Features**, **Plans**, **Notify**, **About** and **Contact**, all
  from one React bundle, routed by `?page=`.
- **The Avahanaa design system**, shared by every page including the legal ones:
  the app's own colour, spacing, radius, shadow, motion and type tokens; the
  brand metal ramp on hero surfaces; a brushed-silver registration plate; light
  and dark palettes that follow the OS or an explicit choice.
- **English and Kannada.** The whole scan path is translated — hero, the seven
  reasons, the form, and every state of the waiting screen — using the app's own
  Kannada strings so the two sides cannot drift. Longer marketing prose falls
  back to English rather than rendering blank.
- QR scanning with the device camera, camera selection, and graceful fallback to
  typing a registration number.
- **The scan path**, which is its own surface rather than a page of the site.
  Arriving from a sticker (`/n/{id}`, or any URL carrying a `qr`/`vehicle`)
  strips the marketing navigation and footer down to a brand mark, the language
  toggle and the theme toggle — nothing that leads away from the one thing the
  visitor came to do. Browsing to Notify from the menu still gets the ordinary
  site.
  - Resolves the vehicle through `/api/qr/{id}` or `/api/lookup?plate=` — server
    side, never Firestore from the browser.
  - **Confirms the vehicle first**, plate at full size, framed as a question.
    Scanning the sticker one along in a row of parked bikes is a normal mistake
    and this is the only free moment to catch it.
  - Offers the **seven reason codes** in `docs/backend_contract.md`. The codes
    are frozen — the owner's app renders its fallback title from them — but the
    labels are written for the person reading them, so `blocking_driveway`
    leads the list as **"Blocking me in"**: the commonest real scan is a
    two-wheeler boxed in outside a shop, nowhere near a driveway.
  - **One-tap notes** per reason — including the situations the seven codes
    cannot name (lights on, alarm, flat tyre, a pet inside, a tow truck). The
    code stays `other` and the specifics ride in the note, which the server
    passes through verbatim as the notification body.
  - **Shows the alert before it is sent.** A live preview of the owner's
    notification — the real title, the real body — updating as the reason and
    note change. Nobody should have to set off an alarm on a stranger's phone
    without knowing how loud it is.
  - Sends through `POST /api/notify`, which resolves the owner, meters the alert
    and pushes with its own credentials.
  - Offers the browser's location prompt *after* a reason is chosen, never
    blocks on it, and gives up after six seconds.
  - A repeat inside the rate-limit window reads `Retry-After` and shows a
    running clock rather than "give them a few minutes"; the button re-enables
    itself.
- **The reply channel.** After sending, the page polls `/api/status` — first at
  1.2s, then backing off from 2.5s to 8s as the wait lengthens — and flips,
  without a reload, through **sent → on their phone → answered**, counting the
  ETA down from the moment the owner actually replied. It holds a screen wake
  lock for exactly as long as the alert is unanswered, shows how long you have
  been waiting so a quiet screen is never mistaken for a broken one, and stops
  on the first reply. After ten minutes it gives up and offers to check again —
  and when the owner answers that they cannot come, it says what to do instead
  rather than reassuring you again.
- **Plans** mirrors the alert meter in the app's `docs/monetization.md`,
  including the three rules that make it defensible: an emergency is never
  metered, a spent budget produces a quiet alert rather than a missing one, and
  the scanner is told nothing either way.
- **Contact** form writes to a Firestore `contactMessages` collection.
- Shared Firebase project with the Flutter mobile app.

## Folder Structure

```
avahanaa_web/
├── functions/              # Firebase Cloud Functions (Node.js 18, asia-south1)
│   ├── index.js            # resolveQr, notify, status, lookup, deliverAlert,
│   │                       # billingVerify, adSsv, walletClaim, selfTest
│   └── package.json        # firebase-admin + firebase-functions dependencies
├── index.html              # The React single-page application
├── theme.css               # The Avahanaa design system, shared by every page
├── privacy-policy.html     # Legal pages, on the same theme
├── terms-and-conditions.html
├── account-deletion.html
├── firebase.json           # Hosting rewrites, headers, emulator ports
├── firestore.rules         # Owner-only reads; the scan page is refused
├── logo.jpg                # Branding used in headers/footers
└── README.md               # You're here
```

### A note on paths

Every asset and page link is **root-absolute** (`/theme.css`, not
`./theme.css`). A sticker resolves to `/n/{qrCodeId}`, which Hosting rewrites to
`/index.html` while leaving that URL in the address bar — so a relative
reference resolves under `/n/`, the catch-all rewrite answers it with the
homepage's HTML, and the browser drops it for the wrong MIME type. Keep new
references absolute or the scan page loads unstyled.

## Quick Start

### 1. Clone

```bash
git clone <repo> avahanaa_web
cd avahanaa_web
```

### 2. Configure Firebase (shared with the Flutter app)

1. In [Firebase Console](https://console.firebase.google.com/), create or open the **congestion-free** project that the Flutter app already uses.
2. Enable **Firestore** (in production mode) and ensure the mobile app writes `users`, `qrCodes`, and `notifications` documents as shown in the Flutter project (`lib/services/firestore_service.dart`).
3. Under **Project settings → General**, add a **Web app** if one doesn’t exist and copy the config snippet. Paste those values into `index.html` (replace the placeholders in `firebaseConfig`). The supplied config already targets the `congestion-free` project; adjust only if you use a different Firebase project.

### 3. Install Cloud Function dependencies

```bash
cd functions
npm install
cd ..
```

### 4. Emulate Locally (optional but recommended)

If you want to test the notify flow without deploying:

```bash
firebase login       # first time only
firebase use congestion-free   # or run `firebase use <your-project-id>`
firebase emulators:start --only functions,firestore --import=./emulator-data
```

In another terminal, serve the static files (or open `index.html` directly). When a QR is resolved, the callable `notifyOwner` function will run inside the emulator. Populate Firestore with sample documents matching your QR IDs to see full delivery logs.

### 5. Deploy

```bash
firebase deploy --only functions:notifyOwner,hosting
```

Ensure your `firebase.json` hosting section points to this directory (e.g. `"public": "."`) or the folder where you build the static assets. If you want different environments (staging/production), use Firebase hosting targets.

## Notification Flow

1. QR sticker encodes `https://avahanaa.com/n/{qrCodeId}`, or the older
   `https://avahanaa.com/index.html?page=notify&qr={qrCodeId}&v=3`. Both forms
   must keep working — printed stickers cannot be recalled.
2. The landing page (or the Notify view inside `index.html`) loads the vehicle metadata directly from the query parameters first, then resolves missing details through Firestore (`qrCodes` → `users`).
3. When the visitor taps **Notify this owner**, the page calls the callable Cloud Function:

```javascript
firebase.functions().httpsCallable("notifyOwner")({
  qrId,
  userId,
  fcmToken,
  title,
  body,
  metadata: {
    reason,
    message,
    licensePlate,
    carModel,
    color,
    contact, // optional
  },
});
```

4. `functions/index.js` validates the payload, sends an FCM push via `admin.messaging().send`, and writes a Firestore `notifications` document. The Flutter app listens to this collection and displays alerts in real time (`lib/services/firestore_service.dart`).

Because the Cloud Function runs with admin privileges, there’s no need to expose your FCM server key to the browser.

## Contact Form Flow

The Contact page now writes submissions to Firestore’s `contactMessages` collection:

```javascript
await db.collection("contactMessages").add({
  name,
  email,
  message,
  createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  source: "web-contact",
});
```

You can process these entries manually in the Firebase console, export them to BigQuery, or attach an automation (e.g. Cloud Functions onWrite, Zapier) to forward emails if desired.

## Maintenance Tips

- **Security Rules:** Limit who can write to `notifications` and `contactMessages` using Firestore rules. For unauthenticated public writes, consider a moderation workflow or reCAPTCHA to mitigate abuse.
- **Environment Parity:** Keep the web config (`index.html`) and the Flutter `firebase_options.dart` in sync when switching projects.
- **Function Logs:** Inspect Cloud Function logs (`firebase functions:log`) to monitor notification delivery success/failure.
- **Flutter App:** The notifications written by `notifyOwner` follow the schema expected by `NotificationModel` (reason codes align with values defined there). Adjust the reason mapping in the web app if you extend the enum in Flutter.

## Deployment Checklist

1. `firebase login`
2. `firebase use congestion-free`
3. `firebase deploy --only functions:notifyOwner`
4. Build/serve the static site (Firebase Hosting or your preferred CDN).  
   - `firebase deploy --only hosting`. The `/n/**` rewrite and the
     `/notify.html` redirect are already in `firebase.json`.
5. Verify:
   - Firestore `qrCodes` and `users` entries resolve correctly.
   - Contact form entries appear under `contactMessages`.
   - Cloud Function sends pushes to the Flutter app (watch device logs or FCM diagnostics).

With this setup the entire Avahanaa flow—QR resolution, notifications, and contact capture—runs on Firebase, sharing the same project as the Flutter client. No separate backend service is required.  

Happy shipping! 🚗💨
