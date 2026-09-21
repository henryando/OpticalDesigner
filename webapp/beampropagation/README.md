# Beam Propagation

A browser-based Gaussian-beam sandbox: compute the beam radius w(z) through a sequence of thin lenses, cylindrical lenses and prism pairs, fit a beam waist from measured widths, and optionally pull the layout in from an [Optical Table Designer](../../README.md) project.

Hosted at [beampropagation.netlify.app](https://beampropagation.netlify.app). By default nothing is uploaded anywhere — everything runs in your browser and is kept in that browser's localStorage. If the deployment has cloud storage configured, you can also log in and save plots to the cloud (see [Cloud projects](#cloud-projects-optional)).

**New here? Read the [User Guide](USER_GUIDE.md)** — a step-by-step walkthrough with screenshots. This README is the feature summary and the setup / deployment notes.

<p align="center"><img src="docs/screenshots/overview.png" alt="A 1.5:1 telescope in Beam Propagation" width="820" /></p>

This began as the **Beam Propagation** mode inside the Optical Table Designer and is now also a standalone app. The designer still has its own copy of the mode; the two share the same `propagations.csv` file format, so plots move freely between them (see [Relationship to the designer](#relationship-to-the-designer)).

## Features

- **Gaussian propagation** — complex q-parameter with ABCD matrices for free space, thin lenses and prism pairs, computed separately for x and y
- **Optics and test points** — one table holds everything along the beam: spherical, cylindrical-x and cylindrical-y lenses, **prism pairs** (anamorphic expander along X or Y with magnification M, applying q → M²·q on that axis), pass-throughs, and **test points** (a marked z where the beam size is reported). Pick the type in the *Role* column.
- **Radius or diameter** — the **Beam size** toggle in the top row switches every size shown or entered — the initial beam, the plot's y-axis, the results table, the fit report and the PDF — between the 1/e² intensity radius w and diameter D. In diameter mode the divergence is the full angle (2× the half-angle used in radius mode), so size and slope stay consistent. It is saved with each propagation.
- **Interactive plot** — drag any optic's dashed line (or its icon) horizontally to change its z, and a test point's green dashed line (or its label) likewise; drag a lens icon vertically to change f, or a prism-pair icon vertically to change M
- **Per-optic On toggle** — untick an optic in the table to skip it in the propagation without deleting it (its icon and row stay, dimmed); for a test point it hides the marker from the plot
- **Initial beam** — either **local radius + divergence at z = 0** or **waist size + waist z position**
- **Fit from measurements** — enter profiled beam widths at several z positions (paste 2-column `z, w` or 3-column `z, wₓ, w_y` straight from Excel, or drop a CSV file onto the dialog / use **Upload CSV** — a header row is ignored); the ideal-Gaussian formula w(z)² = w₀²·(1 + ((z − z₀)/z_R)²) is fit to give w₀, z₀ and z_R, which are applied to the initial beam
- **Split x / y** — render the two axes stacked or overlaid
- **Import from a designer beam path** — **Upload from project .zip** (next to the optics table heading) reads only the layout from a designer project and opens the path picker, so any propagations inside the zip are ignored; any beam path becomes a propagation with real inter-element distances and lens focal lengths (see the [User Guide](USER_GUIDE.md#import-a-beam-path-from-the-optical-table-designer))
- **Multiple propagations** — each plot lives in its own entry in the left rail; double-click to rename
- **Undo** — `Cmd/Ctrl+Z`; **Save** — `Cmd/Ctrl+S` downloads `propagations.csv`
- **Export** — vector PDF of the active propagation; `propagations.csv` download
- **Cloud projects (optional)** — log in to save plots to the cloud and open them from any computer; opens the Optical Table Designer's cloud projects too
- **Persistence** — plots and the loaded project are saved to localStorage automatically
- **Light / dark theme** toggle in the header

## Using it

The [User Guide](USER_GUIDE.md) covers everything in detail. In short:

1. Click **+ New** in the left rail.
2. In the top row set the wavelength, the distance to plot over, and whether beam size is shown as radius or diameter.
3. Set the initial beam, then add lenses, prism pairs and test points to the optics table (or drag icons on the plot).
4. **Export PDF** (header) for a print-ready plot, or **Download Propagations** (header, or `Cmd/Ctrl+S`) to keep your plots as a `propagations.csv`.

To work from an Optical Table Designer layout, click **Upload from project .zip** next to the *Optics and test points* heading (or **Import…** in the left rail, or open the designer's project from the cloud) — see [Import a beam path](USER_GUIDE.md#import-a-beam-path-from-the-optical-table-designer). `.zip` and `.csv` files can also be dropped anywhere on the page.

Plots and the last loaded project are kept in this browser's localStorage, so they survive reloads but not clearing site data or switching browser/computer — download `propagations.csv` (or save to the cloud) for a durable copy. A project with very large custom symbols can exceed the browser's storage quota; the session still works, but the project would need to be re-uploaded after a reload.

### Cloud projects (optional)

When the deployment has cloud storage configured (see [Cloud setup](#cloud-setup-optional)), a **Log in** button appears in the header; once logged in it becomes a **☁ Cloud ▾** menu with **Open Cloud Project…**, **Save to Cloud…** and **Save to Cloud (update)**. It uses the **same accounts and cloud projects as the Optical Table Designer**: opening a designer project loads its propagations and beam paths, and saving back replaces only the propagations, leaving the rest of the project untouched. See [Cloud projects](USER_GUIDE.md#cloud-projects) in the User Guide for the details, including what happens when someone else has saved the project meanwhile.

## Relationship to the designer

The propagation component, Gaussian maths and `propagations.csv` format started as a **copy** of the ones in `webapp/frontend` (`BeamPropagationMode.jsx`, `gaussian.js`, `propagationCsv.js`, plus small pieces of `csvUtils.js`, `ElementShape.jsx` and `symbols.js`), and the physics (`gaussian.js`) is still identical. While the designer ships its own Beam Propagation mode, a physics fix made in one place needs applying to the other. The two have since diverged in the UI:

- the top row, test points inside the optics table, and the radius/diameter toggle exist only here;
- the project comes from an uploaded `.zip` or a cloud project rather than live designer state, and there is no "← Designer" button.

The **file format is kept compatible in both directions**. Test points are stored in the `Test Points JSON` column (and in the cloud row's `testPoints` field) exactly as the designer expects, and this app folds them back into the optics table on load. The radius/diameter choice is an extra trailing `Width mode` column that the designer ignores; a plot that passes through the designer comes back in radius mode.

## Development

```bash
cd webapp/beampropagation
npm install
npm run dev        # http://localhost:5173
npm run build      # production build into dist/
npm run lint
```

## Cloud setup (optional)

Cloud projects need no new backend: they use the **same Supabase project as the Optical Table Designer** — its `cloud_projects` table, accounts and Row Level Security. If the designer's cloud storage is already set up (see [Cloud setup](../../README.md#cloud-setup-optional) in the main README), all that's left is to give this app the same two values:

1. Copy `.env.example` to `.env.local` and fill in `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the same values as `webapp/frontend/.env.local`) for local development.
2. For the deployed site, add the same two variables in Netlify under Site configuration → Environment variables, then trigger a redeploy — environment variables only take effect on the next build.

Without them the app runs local-only with no Log in button and no errors. The anon key is meant to be public; access is controlled by the Row Level Security policies on the table.

## Deployment (Netlify)

The app is a static Vite build with no server. (The only environment variables are the optional Supabase ones above.) It is deployed as its **own Netlify site**, separate from the designer's, from the same GitHub repository.

1. **Push to GitHub.** Netlify builds from the repository, so `webapp/beampropagation` must be on the branch it deploys (`main`).
2. **Create the site.** In Netlify: *Add new site → Import an existing project → GitHub*, then pick this repository.
3. **Build settings** — set the **Base directory** to `webapp/beampropagation`. The build command (`npm install && npm run build`) and publish directory (`dist`) come from [netlify.toml](netlify.toml) in this folder; if Netlify shows them as empty fields, enter those two values.
4. **Environment variables** (optional, only for cloud storage) — under *Site configuration → Environment variables* add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`, the same values the designer's site uses. Do this before the first deploy, or trigger a redeploy afterwards.
5. **Deploy**, then rename the site under *Site configuration → Site details → Change site name* to `beampropagation`, which gives [beampropagation.netlify.app](https://beampropagation.netlify.app) (if that name is free).
6. **Check it**: the page loads, **Upload Project (.zip)** followed by **Import…** works, and — if you set the variables — a **Log in** button appears and logging in with the lab account works.

**Which `netlify.toml` is used?** The repository root also has one (for the designer, with `base = "webapp/frontend"`). Netlify looks for the config file in the package directory, then the *base directory*, then the repository root, and uses the first one it finds — so with the base directory set as above, this folder's file is used and the root one is ignored. If a deploy log ever shows it building `webapp/frontend`, the base directory isn't set.

A push to `main` triggers a build of **both** Netlify sites, since they share the repository. That is harmless — each builds only its own folder — but if the extra builds bother you, Netlify's *ignore builds* setting can skip a site's build when nothing in its folder changed.

## Documentation images

`docs/screenshots/` holds the images used by the User Guide and this README, and `docs/example-measurements.csv` is a sample data set for the *Fit from measurements* dialog. The repository's top-level `.gitignore` excludes `*.png`; this folder's own `.gitignore` re-includes the screenshots.
