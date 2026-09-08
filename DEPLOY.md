# Deploying avahanaa.com

This repo now owns **hosting, Cloud Functions, Firestore rules and indexes**
for the `congestion-free` project. The Flutter app repo (`Avahanaa`) also
contains a `functions/` + `public/` + `firestore.rules` tree from an earlier
attempt.

> **Never run `firebase deploy` from the Avahanaa app repo.** Its hosting root
> is a bare scan page, and deploying it replaces the marketing site. Delete
> that tree once this has shipped.

## The order matters

Steps 1–4 must go out **together**. In between them the site is broken in one
direction or the other:

- rules first → the old page's `users` reads start failing, scan flow dies
- page first → the new page calls `/api/*` functions that do not exist yet

So: deploy functions, then rules, then hosting. Functions first is safe because
nothing routes to them until hosting lands.

### 1. Install and check

```bash
cd functions && npm install && node --check index.js && cd ..
```

### 2. Indexes first, and wait for them

The plate lookup queries `qrCodes` on two fields. A composite index that is
still building answers with an error, so let it finish before the code that
needs it is live.

```bash
firebase deploy --only firestore:indexes --project congestion-free
```

Watch until state is **Enabled** in the console under Firestore → Indexes. On a
small collection this is a minute or two.

### 3. Functions

```bash
firebase deploy --only functions --project congestion-free
```

Creates `resolveQr`, `notify`, `lookup`, `status`, `deliverAlert`, and — added
Sep 2026 with the alert budget — `adSsv`, `walletClaim`, `billingVerify`,
`selfTest` and `playNotifications`, all in **asia-south1**. Replaces
`notifyOwner` in **us-central1** with the retirement stub.

`playNotifications` is a Pub/Sub consumer, not an HTTP endpoint. It needs its
topic to exist first:

```bash
gcloud pubsub topics create play-billing-rtdn --project congestion-free
gcloud pubsub topics add-iam-policy-binding play-billing-rtdn \
  --member=serviceAccount:google-play-developer-notifications@system.gserviceaccount.com \
  --role=roles/pubsub.publisher --project congestion-free
```

`billingVerify` calls the Play Developer API with the functions' own service
account. Grant `congestion-free@appspot.gserviceaccount.com` **View financial
data** in Play Console → Users & permissions, or every purchase verifies as 401
and no subscription ever activates. The full checklist — Play products, the
AdMob SSV callback URL, data safety — is `docs/monetization.md` in the app
repo.

`asia-south1` (Mumbai) is deliberate — the previous `notifyOwner` ran in
`us-central1`, roughly 200 ms of round trip away from every Bangalore scanner,
on the one path where the product's whole claim is speed.

Expect a prompt about `notifyOwner` changing. Accept it. Do **not** accept any
prompt offering to delete `notifyOwner` — see step 6.

### 4. Rules, then hosting

```bash
firebase deploy --only firestore:rules --project congestion-free
firebase deploy --only hosting --project congestion-free
```

Run these back to back. Between them, the live page cannot resolve a scan.

### 5. Verify

```bash
# Vehicle description, and nothing else. Use a real, active QR id.
curl -s https://avahanaa.com/api/qr/<REAL_QR_ID> | jq

# Must be 404 with the same body as a nonexistent code.
curl -s -o /dev/null -w '%{http_code}\n' https://avahanaa.com/api/qr/definitely-not-real

# Security headers are back.
curl -sI https://avahanaa.com/ | grep -iE 'x-content-type|x-frame|referrer'

# The stylesheet is served as CSS, not as the homepage's HTML.
#
# Every asset reference is root-absolute for this reason: a sticker lands on
# /n/{qrCodeId}, and a relative `./theme.css` there resolves to /n/theme.css,
# which the catch-all rewrite answers with index.html. The browser then drops
# it for the wrong MIME type and the scan page — the one entry point that
# matters — renders completely unstyled. Nothing else fails, so this is worth
# asserting rather than eyeballing.
curl -sI https://avahanaa.com/theme.css | grep -i 'content-type'   # text/css
curl -s https://avahanaa.com/n/<REAL_QR_ID> | grep -c 'href="/theme.css"'  # 1
```

Then the part that actually matters — **the alert path is not verified until a
real phone rings**:

1. Scan a real sticker with a phone that is not the owner's.
2. Send an alert. The owner's device should alarm on
   `avahanaa_critical_alerts_v3`, not the quiet legacy channel and not
   `avahanaa_quiet_notices_v1`.
3. **Leave it untouched for 3 minutes.** The first escalating reminder must
   fire. This is the regression that matters most: the old `notifyOwner` sent a
   `notification` block, which meant Android displayed it directly and the
   app's reminder scheduling never ran. If no reminder arrives at +3 min, the
   push is not data-only and the fix has not taken.
4. Open the alert, confirm the reminder is cancelled and no +15 min fires.

Then the alert budget, which has its own way of failing quietly:

5. Send **four** alerts to a fresh account (the free allowance is three). The
   fourth must still arrive — on `avahanaa_quiet_notices_v1`, without the alarm
   tone and without a +3 min reminder. An alert that does not arrive at all is
   the failure this feature must never have.
6. Send a fifth with reason `emergency`. It must alarm at full strength
   regardless of the balance. If it does not, `ALWAYS_FREE_REASONS` is not
   being consulted before the balance and the deploy should be rolled back.
7. From the app, Profile → *Test the alarm*. It must ring, and it must not
   decrement the balance shown on the home screen.

Finally, confirm the leak is closed. In the scan page's Network tab there must
be **no request to `firestore.googleapis.com` for `users`**, and no `fcmToken`
or `phoneNumber` anywhere in the responses.

While that tab is open, check the location too: `POST /api/notify` may carry a
`location` object if you allowed the browser prompt, and the coordinates in it
must be **rounded to three decimals**. A full-precision fix reaching the wire
means `sanitiseLocation` is not being applied.

### 6. Retire `notifyOwner` (about a week later)

The stub exists because a scan page cached in someone's browser keeps calling
the old callable. Once the hosting cache has turned over:

```bash
firebase functions:delete notifyOwner --region us-central1 --project congestion-free
```

## notify.html

Deleted, and redirected to `/index.html?page=notify` (301, query string
carried across by Hosting).

It was a second, standalone copy of the scan flow carrying the same leak as the
main page — its own `users/{uid}` read for `fcmToken` and `phoneNumber` — and
it was live: `GET /notify.html` returned 200. The project had already moved to
`index.html?page=notify`, so rather than port the leak twice it redirects to
the one maintained implementation.

The URL is kept rather than dropped because it is not knowable from here
whether any printed sticker points at it. Redirects are evaluated before static
content in Hosting, so this holds even if the file is ever restored.

Verify after deploy:

```bash
curl -sI https://avahanaa.com/notify.html | grep -i 'location\|HTTP/'
```

## Plate lookup

`/api/lookup` preserves the "type a registration number instead of scanning"
feature that production already had. It is the softest target here: a plate can
be guessed, a sticker cannot. It is rate-limited per IP (5 per 5 min, 20 per
hour) and returns only a QR id plus the vehicle description.

To switch it off entirely, set in `functions/.env`:

```
PLATE_LOOKUP_ENABLED=false
```

It then answers 404 for everything, and the page falls back to scan-only.

**It does not work until the app ships the matching write.** The lookup matches
`metadata.vehicle.licensePlateCanonical`, a normalised copy of the plate added
to `QrPayloadBuilder.buildMetadata` in the app repo. Existing `qrCodes`
documents do not have it, so:

- Vehicles re-saved by an updated app get the field automatically.
- Everything else needs a one-off backfill, or plate lookup silently returns
  "no vehicle matches that number" for them.

`canonicalisePlate` exists in both `functions/index.js` and
`lib/utils/qr_payload_builder.dart` and the two must stay identical — they are
the read and write halves of one index.

## Legacy encrypted stickers

The v1/v2 QR payloads were AES-encrypted blobs that embedded the owner's
**FCM token in the sticker itself**. Those stickers are on windshields and
cannot be recalled.

The page still decodes them, because retiring a printed QR route is not an
option — but it now discards the embedded token, and `/api/notify` accepts no
token from any client regardless. The tokens stay valid until each owner's app
rotates them; there is no way to force that from here. Treat any future FCM
token rotation as a security improvement, not housekeeping.

## Watch item

`FirestoreService.syncQrCodeMetadata` (app repo, `firestore_service.dart:469`)
does a merge-set on `qrCodes` **without** `userId`. On an existing document
that is fine — the merge keeps the field. If the document does not exist, it
becomes a create, and the create rule requires `userId`, so it will be denied
and the error is swallowed by a `debugPrint`. It is a legacy path and may never
be hit; if QR metadata ever appears not to save, this is why.
