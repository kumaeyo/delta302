# Delta 302

A small mobile-first spending tracker for three housemates. It records an item, price, payer, and whether the cost is split by three, two, or not split at all, then calculates each person's share and the settlement payments for the active cycle.

## Open The App

Open `index.html` in a browser. The app works immediately with local device storage.

## GitHub Pages Upload

Upload these files to the root of your GitHub repository:

- `index.html`
- `styles.css`
- `app.js`
- `manifest.webmanifest`
- `sw.js`

Optional but recommended:

- `README.md`
- `google-apps-script.gs`

Only the first five files are required for the app screen. Keep `google-apps-script.gs` in the repo if you want the Sheet setup code easy to find later.

## Google Sheets Storage

1. Create a Google Sheet.
2. In the Sheet, open **Extensions > Apps Script**.
3. Put the contents of `google-apps-script.gs` into the Apps Script editor.
4. Deploy it as a **Web app** with:
   - **Execute as:** Me
   - **Who has access:** Anyone with the link
5. Open the deployed web app URL once so Google can authorize it.
6. The app currently uses this deployed URL by default:
   `https://script.google.com/macros/s/AKfycbw1AbCSDKJCnnPF4hMZXjJxE3Fq9_1onlR_TNEeeW5WLrcuBAcsGcUufrNlug-hLSi-7g/exec`

Use the same GitHub Pages app on every phone. The Google Sheet is the shared backend:

- `People` stores the three shared person names.
- `Expenses` stores the active shared spending records.
- `Settings` stores the active cycle name and paid settlement markers, so every phone shares the same cycle status.
- `Cycles` stores each closed cycle summary.
- `Archive` stores closed cycle spending after **Close cycle**.

When one phone adds spending, the app appends that record to the Sheet. Other phones will see it after opening the app, refreshing, or tapping **Sync**. If person names are edited, tap **Save** in settings, then tap **Sync** on the other phones.

## If Sync Shows Sheet Error

Check these in order:

1. The hardcoded URL in `app.js` must be the deployed Apps Script **Web app** URL ending in `/exec`, not the Apps Script editor URL and not a `/dev` URL.
2. Make sure that exact Apps Script deployment uses the newest backend code from `google-apps-script.gs`.
3. After editing `google-apps-script.gs`, deploy a **New version** in Apps Script. Saving the script is not enough.
4. Open the `/exec` URL in a browser. It should show JSON that starts with `{"ok":true`.
5. Push the newest `app.js` and `sw.js` to GitHub Pages, then fully close and reopen the app on each phone.
6. If the home-screen app still uses old files, remove the home-screen icon and add it again from the GitHub Pages URL.

The script creates five tabs in the Sheet:

- `People`
- `Expenses`
- `Archive`
- `Settings`
- `Cycles`

Mark each settlement row as **Paid** first. When every settlement is paid, **Close cycle** becomes available. Tapping it moves current expenses into `Archive`, saves a summary in `Cycles`, clears the paid settlement markers, and moves the active cycle to the next month name. The transaction dates can be from any month; the cycle name is controlled separately.

## Data Model

Each expense stores:

- `item`
- `amount`
- `paidBy`
- `participants`
- `date`
- `createdAt`

For no-split records, `participants` contains one person. If that person is the payer, it records their own expense with no debt. If that person is someone else, it records that the payer paid fully for that person.

Balances are calculated as:

- `Paid`: total amount the person paid up front
- `Share`: total amount the person owes from included expenses
- `Balance`: `Paid - Share`
