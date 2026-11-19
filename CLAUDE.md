# CV Intelligence

A Stott and May tool. A consultant uploads a PDF or Word CV and gets target companies, live vacancies, selling points, quantified achievements, a pitch guide, an optional job match against a pasted job spec, and an intro email to a hiring manager, and can download the CV formatted as a Stott and May PDF or Word document. Filters: company size (up to 50, 200, 500 or 1,000 employees) and location.

## Working with Ian

Ian owns this project. He is not a developer. Explain plans in plain English before acting, work in small steps, commit after each working step with a clear message, and give click-by-click instructions for anything outside the code (Railway, Anthropic Console). Ask before creating or changing anything in Railway.

## Stack

- `server.js`: Express. Serves `public/` and `/api/*`. The only place the Anthropic API key is used.
- `lib/extract.js`: PDF (unpdf) and .docx (mammoth) to text, in memory only. Scanned PDFs return a clear 422 message.
- `lib/claude.js`: all Claude calls (`@anthropic-ai/sdk`), cost per call (logged as `claude_call`), web search result URLs.
- `lib/prompts.js`: system prompts and the analysis JSON schema.
- `lib/verify.js`: server-side checks on everything Claude returns (see Rules). Tests in `test/` (`npm test`).
- `public/`: plain HTML, CSS and JavaScript. Model output is only ever inserted with `textContent`.

- `lib/house.js`: signing in through the House (see Sign-in below).
- `lib/format.js`: formats the CV as a Stott and May PDF (pdfkit) or Word file (docx), in memory only. Three templates, ported from Ian's CV Formatter Artifact (https://claude.ai/artifact/355hBR7g7Lg24CQYYcMvop, kept as a standalone tool): `basic` (CV only), `medium` (Candidate Profile page, then the CV), `long` (cover, profile, CV, "Get in touch" page with the consultant's details). The candidate's own email, phone, home address and LinkedIn are always removed from the CV body. Fonts (Manrope, Inter, SIL Open Font Licence) are in `lib/fonts/`. The Word version matches the PDF by putting the decorative parts (gradient bars, cover and closing pages, grey profile page, black footer) behind the text as images from `lib/assets/`, drawn by `scripts/make-word-assets.py`; rerun it if the design changes. Tests in `test/format.test.js`.

Routes: `GET /healthz` (no auth, returns `ok`), `POST /api/check`, `POST /api/analyse` (multipart: `cv`, `jobSpec`, `maxSize`, `location`), `POST /api/vacancies`, `POST /api/email`, `POST /api/format` (JSON: `template`, `format` pdf or docx, `cvText`, `fields`; returns the file). Every `/api` route needs a signed-in person (see Sign-in). `GET /session` (no auth) tells the page whether you're signed in and where to sign in; `POST /signout` signs you out of this tool. `GET /house-link` (no auth) returns the House's hallway address for the "The House" button in the top bar (November 2026).

## Sign-in (through the House, November 2026)

Agreed with Ian: people sign in once, at the House (`stott2026/the-house`, an emailed 6-digit code), and this tool trusts it. Going through the Gallery's door arrives with `?house_pass=…`: a pass signed by the House (Ed25519), naming the person and this tool's address, valid 60 seconds and once only. `lib/house.js` checks it with the House's public key (fetched from `<HOUSE_URL>/auth/pass-key`, refetched if the House's key changes), sets this tool's own signed cookie (`cvi_session`, 7 days) and tidies the address. Opening the tool without being signed in redirects to `<HOUSE_URL>/pass?for=<this address>`, which signs you in to the House if needed and sends you back with a pass. "Sign out" signs out of this tool and goes back to the House's hallway. Backup, switched off: `BACKUP_ACCESS_CODE=true` on Railway makes the old shared `ACCESS_CODE` work again (only for if the House is down). Don't change sign-in from another chat without checking with Ian: it's shared with the House and the other tools.

Settings: `ANTHROPIC_API_KEY`, `HOUSE_URL` (needed for sign-in), optional `SESSION_SECRET` (signs this tool's cookie; without it one is made at start-up and people are sent through the House again after a restart), `ACCESS_CODE` with `BACKUP_ACCESS_CODE=true` (the backup only), optional `ANTHROPIC_MODEL` (default `claude-opus-5-5`), `PORT`, and `HOUSE_URL` also shows a "The House" button in the top bar, to `<HOUSE_URL>/?hallway` (this tool is the Gallery there). Locally they go in `.env` (git-ignored, never commit it); on Railway they are service variables only. `.env.example` lists every name.

## Rules (do not break these)

- **Secrets**: the API key, the access code and the session secret never reach the browser or the repo.
- **No invented figures, companies or links anywhere.** Enforced in `lib/verify.js`, not just in prompts:
  - A number may only be shown if it appears in the CV text. Achievements tagged "From CV" must have a figure found in the CV; otherwise they become "Inferred - check" with no figure, or are dropped. Emails quoting a number not in the CV are regenerated once, then refused.
  - Companies above the chosen size limit, or without a size estimate, are removed. The limit can never exceed 1,000.
  - A vacancy is only shown if its URL appeared in the web search results of that same call.
- The Job match tab only appears when a job spec is pasted.
- Format CV: the profile page is pre-filled only from checked analysis output (summary, achievements marked "From CV"); salary, notice and so on are typed by the consultant. Never put the candidate's own contact details in a formatted CV.
- CVs are not stored. Do not add a database or logging of CV content.

## Brand

Stott and May brand: Manrope for headings and body, Inter inside cards and data. Gradient teal `#00C8C8` to aquamarine `#73F7BB`. Neutrals `#111314`, `#7A8798`, `#C3CAD2`, `#ECEEF3`, `#FFFFFF`. Official transparent logo files in `public/` (`logo-light-bg.png`, `logo-dark-bg.png`), no white box behind the logo. Light and dark mode, works at phone width. British English, "Stott and May" written in full, spaced hyphens ( - ) instead of em dashes (also enforced by `houseStyle()` on model output).

## Status and plan (November 2026)

Built on branch `claude/quirky-einstein-vw5kil` and merged into `main` on 18 November 2026 (Stott2026/cv-intelligence#1). Work from a new branch off `main` and merge through a pull request. Checked before the merge: .docx and text PDF extraction, scanned-PDF message, access code, verification tests, layout at desktop and phone width in light and dark (with mock data).

Progress (17 November 2026): steps 1 to 3 below are done with a real CV (junior software engineer). All checks passed: companies within the size limit, achievements only use CV figures, job match only with a spec, email and Copy, .docx, text PDF, scanned-PDF message, brand, light and dark, phone width. Web search is enabled. Fixes made: no guessed pronouns, company sizes labelled as Claude's estimates, tabs wrap, broader vacancy search (10 searches) matched to a new `seniority` field. Vacancy search finds only 0 to 1 suitable jobs per run for this junior candidate, at about $0.22 to $0.33 per search; links could not be opened from the cloud session because its network blocks job sites. Full run cost before the vacancy changes was $0.267. Ian chose to keep the vacancy search as it is (few but well matched). Vacancy `whySuitable` sentences with numbers not in the CV are removed.

Railway (17 November 2026): project "CV Intelligence", service `cv-intelligence`, deploys from `main` on every push (switched from the working branch after the merge on 18 November 2026), so anything merged into `main` goes live within about a minute, start command `npm start`, healthcheck `/healthz`, region Amsterdam (`ams`, moved from US West at Ian's request so CVs stay on a European server). Domain: https://cv-intelligence-production-afb09260.up.railway.app. First deploy succeeded. `ANTHROPIC_API_KEY` and `ACCESS_CODE` are set by Ian in the Railway dashboard (not through Claude, so the key never appears in a chat). The cloud session's network cannot reach railway.app, so live checks are done by Ian in a browser or through Railway's logs.

Live (18 November 2026): working on Railway. Node is pinned to 22.x in package.json because unpdf needs Node 22 (on Node 20 every PDF failed to open). Real costs from the live logs, 4 runs: analysis $0.09 to $0.13, vacancy search $0.20 to $0.38 (10 searches each, 44 to 136 seconds), email about $0.014 (measured locally; not yet used live). One full run is about $0.30 to $0.53, typically around $0.42. All five steps below are done.

Original plan (all done):
1. Run locally with Ian's real key and access code.
2. End-to-end test with a real CV: valid JSON; every company 1,000 employees or fewer; achievements only use CV figures and are tagged correctly; vacancies real and current (open a sample of links and report how many are live and relevant); job match only with a spec; email and Copy work; .docx, text PDF, and scanned PDF message. If web search is not enabled on the Anthropic organisation, tell Ian exactly where to turn it on.
3. Check the interface in a browser against the brand rules above.
4. Deploy to Railway from this GitHub repository (ask Ian first). `ANTHROPIC_API_KEY` and `ACCESS_CODE` as service variables only. Generate a domain, confirm `/healthz` returns ok and that `/api` rejects requests without the access code.
5. Report the cost of one full run (analysis, vacancy search and email) from real usage numbers. Each call's cost is shown under the results and logged by the server.
