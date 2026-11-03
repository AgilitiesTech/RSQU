# RSQU
A mobile RV and Trailer Mechanic

## Website: Mike Stevens Emergency RV & Trailer Repair

- `index.html`, `winterize.html` and `404.html`: since November 3, 2026 these only send visitors to Mike's site on HitchPoint (https://gethitchpoint.com/s/mike-stevens), where he manages it himself. The original pages are in the git history. `guides/` (his checklist PDFs) and `img/` stay published here so links people already have keep working.
- `forms.js`: sends both website forms to Mike’s dashboard (set `<meta name="rsqu-api">` in each page); until that’s set it opens a pre-filled text to Mike instead.
- `admin/`: **HitchPoint**, the white-label platform for RV and trailer repair businesses, run by Agilities: the owner-recruiting landing page, sign-up with required direct-deposit setup, branded hosted websites, request inbox, deposits, onsite quotes, signed proposals, online card and bank payments straight into each owner’s own Stripe account (the business is the merchant of record; Processing Fee = Stripe’s fee + HitchPoint’s 3% application fee), owner-approved customer Terms & Conditions, and the Agilities super admin with leads. Setup, Stripe and operating steps are in `admin/README.md`.
- `.github/workflows/pages.yml`: deploys the website pages (`*.html`, `*.js` at the repo root) to GitHub Pages on every push to `main` that changes them (or run it by hand from the Actions tab). Only the website is published, not `admin/`, `design/` or this README.
- `design/Main.dc.html` and `design/canvas.json`: the original design source from the Claude design canvas, kept for reference and future edits there.

Live at https://agilitiestech.github.io/RSQU/ (Pages source: GitHub Actions). It now forwards to https://gethitchpoint.com/s/mike-stevens. If Mike's own domain goes live, change the address in the three pages to it.

### Still to do before launch
- Fill in the last placeholder in the home page FAQ: Mike’s hours.
- Deploy `admin/` (see `admin/README.md`), then set `<meta name="rsqu-api">` (and `rsqu-business` if his business slug differs from `mike-stevens`) in both pages so forms go to the dashboard instead of a text message.
