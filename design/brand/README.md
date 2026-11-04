# HitchPoint logo

A folk-style pine tree, built from three stacked chevrons, inside a map pin, with an orange sun and an orange trunk. The wordmark is Bitter ExtraBold (the home page's heading face), outlined so it never depends on a font, with orange diamonds for the dots on the i's.

| File | Use |
| --- | --- |
| `logo.svg` | Full logo on light backgrounds (sign-in screens, documents) |
| `logo-on-dark.svg` | Full logo on dark backgrounds (home page header and footer, dashboard header, legal page header) |
| `mark.svg` / `mark-on-dark.svg` | The pin on its own, for small spaces |
| `icon.svg` | App icon and favicon: the pin on a rounded pine tile (also `admin/public/brand/favicon.svg`) |
| `icon-fullbleed.svg` | Square app icon with no rounded corners, for the App Store and Play Store (they round it themselves) |
| `icon-maskable.svg` | Android adaptive icon: the pin sized to Android's safe zone |

The served copies live in `admin/public/brand/`. The PNG icons there (`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`) are made from these files with `rsvg-convert`, and the phone app icons and splash screens in `mobile/` are made from them too.

## Colors (the home page palette)

| Name | Hex | Where |
| --- | --- | --- |
| Pine | `#1F3D35` | The pin, the icon tile, outline buttons |
| Deep pine | `#16302A` | Dashboard header and phone tab bar, app theme color |
| Night | `#0E2236` | Home page sky, text on orange buttons |
| Navy | `#10243A` | Home page, legal page header |
| Orange | `#FF7A1A` | Sun, trunk, main buttons, "new" tags |
| Ember | `#FF9A3C` | Highlights on dark backgrounds |
| Cream | `#FBF7F0` | Page background, the pin on dark backgrounds |
| Sand | `#F4EBDD` | Sign-in background with the topo lines |

Type: Bitter (700, 800) for headings, Barlow (400–700) for everything else.

## What keeps each business's brand

Customers never see HitchPoint's look. Business websites, proposals, payment pages, receipts and a business's own terms page keep that business's name, logo and colors. Only HitchPoint's own pages load `admin/public/hp.css`: the home page, sign-in and sign-up, every dashboard (owners and their team, Agilities admin, affiliates), the offline page and the legal pages.
