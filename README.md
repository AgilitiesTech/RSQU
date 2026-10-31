# RSQU
A mobile RV and Trailer Mechanic

## Website: Mike Stevens Emergency RV & Trailer Repair

- `index.html`: the home page (emergency repair). `winterize.html`: the $499 onsite winterizing package with the full checklist. Each is a self-contained page (HTML, inline CSS, a little vanilla JS). Open it in a browser or deploy it to any static host (GitHub Pages, Netlify, Vercel, S3).
- `forms.js`: sends both website forms to Mike’s dashboard (set `<meta name="rsqu-api">` in each page); until that’s set it opens a pre-filled text to Mike instead.
- `admin/`: the white-label service platform run by Agilities: business sign-up, branded hosted websites, request inbox, deposits, onsite quotes, signed proposals, Stripe Connect payments with a 3% Processing Fee to Agilities, and the Agilities super admin. Setup, Stripe and operating steps are in `admin/README.md`.
- `.github/workflows/pages.yml`: deploys the website pages (`*.html`, `*.js` at the repo root) to GitHub Pages on every push to `main` that changes them (or run it by hand from the Actions tab). Only the website is published, not `admin/`, `design/` or this README.
- `design/Main.dc.html` and `design/canvas.json`: the original design source from the Claude design canvas, kept for reference and future edits there.

Live at https://agilitiestech.github.io/RSQU/ (Pages source: GitHub Actions).

### Still to do before launch
- Fill in the last placeholder in the home page FAQ: Mike’s hours.
- Deploy `admin/` (see `admin/README.md`), then set `<meta name="rsqu-api">` (and `rsqu-business` if his business slug differs from `mike-stevens`) in both pages so forms go to the dashboard instead of a text message.
