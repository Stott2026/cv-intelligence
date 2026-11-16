# CV Intelligence

A Stott and May tool for consultants. Upload a PDF or Word CV and get:

- **Target companies** - real companies up to the chosen size (50, 200, 500 or 1,000 employees, never more) in or near the chosen location
- **Live vacancies** - found by web search; only links that appeared in the search results are shown
- **Selling points** and **achievements** - each marked "From CV" or "Inferred - check"; figures only ever come from the CV
- **Pitch guide** for a phone call
- **Job match** - only when a job spec is pasted
- **Intro email** to a hiring manager, with a Copy button

## How it works

- `server.js` - Express server. Serves `public/` and the `/api` routes. The only place the Anthropic API key is used.
- `lib/extract.js` - reads text from PDF and .docx in memory (nothing is saved). Scanned PDFs get a clear message.
- `lib/claude.js` - calls to Claude, cost reporting.
- `lib/prompts.js` - instructions and output shapes for each call.
- `lib/verify.js` - checks applied to every answer: numbers must be in the CV, companies over the size limit removed, vacancy links must appear in the web search results, spaced hyphens instead of dashes.
- `public/` - the page (plain HTML, CSS and JavaScript) and the official logo files.

Every `/api` route needs the access code (sent as the `x-access-code` header). `/healthz` returns `ok` for Railway's health check.

## Run it locally

Needs Node 20 or newer.

```bash
npm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY and ACCESS_CODE
npm run dev            # http://localhost:3000
npm test               # checks for the verification rules
```

## Settings

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key. Server only. |
| `ACCESS_CODE` | The code consultants type to use the app. |
| `ANTHROPIC_MODEL` | Optional. Default `claude-opus-5-5`. |
| `PORT` | Optional. Railway sets it. |

Vacancy search uses Anthropic's web search tool, which must be enabled for the Anthropic organisation.
