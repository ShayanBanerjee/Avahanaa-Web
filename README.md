# Avahanaa – Vehicle QR Notification Website

Avahanaa lets anyone discreetly reach a vehicle owner by scanning a QR code or entering the number plate printed on the sticker. Each code maps to the owner’s record in Firestore; when a passer-by triggers an alert, a Firebase Cloud Function delivers a push notification to the owner’s Flutter app (see `lib/main.dart` in the mobile project) via Firebase Cloud Messaging (FCM). The web experience is a single-page React interface rendered from `index.html`, styled with Bootswatch Flatly, Bootstrap Icons, and the Google Poppins font.

This repository now relies entirely on Firebase services—Firestore for lookup/contact storage and Cloud Functions for push delivery—so no separate Node/Express backend is required.

## Features

- **Home**, **About**, **Notify**, and **Contact** views rendered from one React bundle.
- QR / vehicle lookup with graceful fallback to manual entry when camera access isn’t available.
- “How it works” walkthrough explaining the scan → notify flow.
- **Notify** workflow:
  - Resolves the owner by QR ID or licence plate (Firestorm lookups with demo fallback when Firebase isn’t configured).
  - Presents friendly, icon-driven reason buttons plus optional note/contact fields.
  - Calls the `notifyOwner` Cloud Function, which sends an FCM push and logs the alert in Firestore’s `notifications` collection for the mobile app to consume.
- **Contact** form writes directly to a Firestore `contactMessages` collection so the team can review submissions inside the Firebase console (or build an automation).
- Shared Firebase project with the Flutter mobile app, so web and mobile reference the same data and notification registers.

## Folder Structure

```
avahanaa_web/
├── functions/              # Firebase Cloud Functions (Node.js 18)
│   ├── index.js            # notifyOwner callable function
│   └── package.json        # firebase-admin + firebase-functions dependencies
├── index.html              # Main React single-page application
├── notify.html             # Stand-alone QR landing page used when a code is scanned
├── logo.jpg                # Branding used in headers/footers
└── README.md               # You’re here
```

## Quick Start

### 1. Clone

```bash
git clone <repo> avahanaa_web
cd avahanaa_web
```

### 2. Configure Firebase (shared with the Flutter app)

1. In [Firebase Console](https://console.firebase.google.com/), create or open the **congestion-free** project that the Flutter app already uses.
2. Enable **Firestore** (in production mode) and ensure the mobile app writes `users`, `qrCodes`, and `notifications` documents as shown in the Flutter project (`lib/services/firestore_service.dart`).
3. Under **Project settings → General**, add a **Web app** if one doesn’t exist and copy the config snippet. Paste those values into both `index.html` and `notify.html` (replace the placeholders in `firebaseConfig`). The supplied config already targets the `congestion-free` project; adjust only if you use a different Firebase project.

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

1. QR sticker encodes a URL such as `https://avahanaa.com/notify.html?qr=<ID>`.
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
- **Environment Parity:** Keep the Web config (`notify.html`, `index.html`) and Flutter `firebase_options.dart` in sync when switching projects.
- **Function Logs:** Inspect Cloud Function logs (`firebase functions:log`) to monitor notification delivery success/failure.
- **Flutter App:** The notifications written by `notifyOwner` follow the schema expected by `NotificationModel` (reason codes align with values defined there). Adjust the reason mapping in the web app if you extend the enum in Flutter.

## Deployment Checklist

1. `firebase login`
2. `firebase use congestion-free`
3. `firebase deploy --only functions:notifyOwner`
4. Build/serve the static site (Firebase Hosting or your preferred CDN).  
   - For Firebase Hosting add a rewrite for `/notify.html` if needed and upload via `firebase deploy --only hosting`.
5. Verify:
   - Firestore `qrCodes` and `users` entries resolve correctly.
   - Contact form entries appear under `contactMessages`.
   - Cloud Function sends pushes to the Flutter app (watch device logs or FCM diagnostics).

With this setup the entire Avahanaa flow—QR resolution, notifications, and contact capture—runs on Firebase, sharing the same project as the Flutter client. No separate backend service is required.  

Happy shipping! 🚗💨
