# RSQU
A mobile RV and Trailer Mechanic

## Website: Mike Stevens Emergency RV & Trailer Repair

- `index.html`: the website, a single self-contained page (HTML, inline CSS, a little vanilla JS). Open it in a browser or deploy it to any static host (GitHub Pages, Netlify, Vercel, S3).
- `.github/workflows/pages.yml`: deploys `index.html` to GitHub Pages on every push to `main` that changes it (or run it by hand from the Actions tab). Only the page itself is published, not `design/` or this README.
- `design/Main.dc.html` and `design/canvas.json`: the original design source from the Claude design canvas, kept for reference and future edits there.

### Still to do before launch
- Turn on Pages once: repo **Settings → Pages → Build and deployment → Source: GitHub Actions**. The site will be at https://agilitiestech.github.io/RSQU/. Pages on a private repo requires GitHub Pro (or make the repo public).
- Fill in the placeholders on the page: `[DEPARTMENT NAME]`, service cities and counties, hours, and pricing.
- Replace the photo placeholder with a real photo of Mike and his service truck.
- Connect the repair request form to a delivery service (see the `TODO` in the script at the bottom of `index.html`). Right now it validates and shows the confirmation, but nothing is sent.
