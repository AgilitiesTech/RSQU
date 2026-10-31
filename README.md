# RSQU
A mobile RV and Trailer Mechanic

## Website: Mike Stevens Emergency RV & Trailer Repair

- `index.html`: the home page (emergency repair). `winterize.html`: the $499 onsite winterizing package with the full checklist. Each is a self-contained page (HTML, inline CSS, a little vanilla JS). Open it in a browser or deploy it to any static host (GitHub Pages, Netlify, Vercel, S3).
- `.github/workflows/pages.yml`: deploys the `.html` pages to GitHub Pages on every push to `main` that changes them (or run it by hand from the Actions tab). Only the pages are published, not `design/` or this README.
- `design/Main.dc.html` and `design/canvas.json`: the original design source from the Claude design canvas, kept for reference and future edits there.

Live at https://agilitiestech.github.io/RSQU/ (Pages source: GitHub Actions).

### Still to do before launch
- Fill in the two remaining placeholders in the home page FAQ: hours and emergency call-out pricing.
- Replace the photo placeholder with a real photo of Mike and his service truck.
- Connect the repair request and winterizing booking forms to a delivery service (see the `TODO` in the script at the bottom of each page). Right now it validates and shows the confirmation, but nothing is sent.
