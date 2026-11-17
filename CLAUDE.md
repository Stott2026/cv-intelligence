# CV Intelligence

A Stott and May tool. A consultant uploads a PDF or Word CV and gets target companies, live vacancies, selling points, quantified achievements, a pitch guide, an optional job match against a pasted job spec, and an intro email to a hiring manager. Filters: company size (up to 50, 200, 500 or 1,000 employees) and location.

## Working with Ian

Ian owns this project. He is not a developer. Explain plans in plain English before acting, work in small steps, commit after each working step with a clear message, and give click-by-click instructions for anything outside the code (Railway, Anthropic Console). Ask before creating or changing anything in Railway.

## Stack

- `server.js`: Express. Serves `public/` and `/api/*`. The only place the Anthropic API key is used.
- `lib/extract.js`: PDF (unpdf) and .docx (mammoth) to text, in memory only. Scanned PDFs return a clear 422 message.
- `lib/claude.js`: all Claude calls (`@anthropic-ai/sdk`), cost per call (logged as `claude_call`), web search result URLs.
- `lib/prompts.js`: system prompts and the analysis JSON schema.
- `lib/verify.js`: server-side checks on everything Claude returns (see Rules). Tests in `test/` (`npm test`).
- `public/`: plain HTML, CSS and JavaScript. Model output is only ever inserted with `textContent`.

Routes: `GET /healthz` (no auth, returns `ok`), `POST /api/check`, `POST /api/analyse` (multipart: `cv`, `jobSpec`, `maxSize`, `location`), `POST /api/vacancies`, `POST /api/email`. Every `/api` route needs the `x-access-code` header to match `ACCESS_CODE`.

Settings: `ANTHROPIC_API_KEY`, `ACCESS_CODE`, optional `ANTHROPIC_MODEL` (default `claude-opus-5-5`), `PORT`. Locally they go in `.env` (git-ignored, never commit it); on Railway they are service variables only. `.env.example` lists every name.

## Rules (do not break these)

- **Secrets**: the API key and access code never reach the browser or the repo.
- **No invented figures, companies or links anywhere.** Enforced in `lib/verify.js`, not just in prompts:
  - A number may only be shown if it appears in the CV text. Achievements tagged "From CV" must have a figure found in the CV; otherwise they become "Inferred - check" with no figure, or are dropped. Emails quoting a number not in the CV are regenerated once, then refused.
  - Companies above the chosen size limit, or without a size estimate, are removed. The limit can never exceed 1,000.
  - A vacancy is only shown if its URL appeared in the web search results of that same call.
- The Job match tab only appears when a job spec is pasted.
- CVs are not stored. Do not add a database or logging of CV content.

## Brand

Stott and May brand: Manrope for headings and body, Inter inside cards and data. Gradient teal `#00C8C8` to aquamarine `#73F7BB`. Neutrals `#111314`, `#7A8798`, `#C3CAD2`, `#ECEEF3`, `#FFFFFF`. Official transparent logo files in `public/` (`logo-light-bg.png`, `logo-dark-bg.png`), no white box behind the logo. Light and dark mode, works at phone width. British English, "Stott and May" written in full, spaced hyphens ( - ) instead of em dashes (also enforced by `houseStyle()` on model output).

## Status and plan (November 2026)

Built and pushed on branch `claude/quirky-einstein-vw5kil`. Checked so far: .docx and text PDF extraction, scanned-PDF message, access code, verification tests, layout at desktop and phone width in light and dark (with mock data).

Progress (17 November 2026): steps 1 to 3 below are done with a real CV (junior software engineer). All checks passed: companies within the size limit, achievements only use CV figures, job match only with a spec, email and Copy, .docx, text PDF, scanned-PDF message, brand, light and dark, phone width. Web search is enabled. Fixes made: no guessed pronouns, company sizes labelled as Claude's estimates, tabs wrap, broader vacancy search (10 searches) matched to a new `seniority` field. Vacancy search finds only 0 to 1 suitable jobs per run for this junior candidate, at about $0.22 to $0.33 per search; links could not be opened from the cloud session because its network blocks job sites. Full run cost before the vacancy changes was $0.267. Ian chose to keep the vacancy search as it is (few but well matched). Vacancy `whySuitable` sentences with numbers not in the CV are removed.

Still to do, in order:
1. Run locally with Ian's real key and access code.
2. End-to-end test with a real CV: valid JSON; every company 1,000 employees or fewer; achievements only use CV figures and are tagged correctly; vacancies real and current (open a sample of links and report how many are live and relevant); job match only with a spec; email and Copy work; .docx, text PDF, and scanned PDF message. If web search is not enabled on the Anthropic organisation, tell Ian exactly where to turn it on.
3. Check the interface in a browser against the brand rules above.
4. Deploy to Railway from this GitHub repository (ask Ian first). `ANTHROPIC_API_KEY` and `ACCESS_CODE` as service variables only. Generate a domain, confirm `/healthz` returns ok and that `/api` rejects requests without the access code.
5. Report the cost of one full run (analysis, vacancy search and email) from real usage numbers. Each call's cost is shown under the results and logged by the server.
