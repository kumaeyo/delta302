# Delta 302

A small mobile-first spending tracker for three housemates. It records an item, price, payer, and whether the cost is split by two or three people, then calculates each person's share and the settlement payments for the month.

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
6. Paste the deployed URL into **Settings > Google Sheet app URL** inside Delta 302.

The script creates three tabs in the Sheet:

- `People`
- `Expenses`
- `Archive`

When you tap **Reset**, current expenses are moved into `Archive` and the active month starts from zero.

## Data Model

Each expense stores:

- `item`
- `amount`
- `paidBy`
- `participants`
- `date`
- `createdAt`

Balances are calculated as:

- `Paid`: total amount the person paid up front
- `Share`: total amount the person owes from included expenses
- `Balance`: `Paid - Share`
