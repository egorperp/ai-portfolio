# yegor-ai: AI tools portfolio on Cloudflare Workers

Live: https://yegor-ai.workers.dev

| Path | What it is |
|---|---|
| `/` | Portfolio |
| `/ask/` | **Ask the documents**: upload PDF, Word or text files and ask questions in Slovenian or English. Retrieval (BM25 with stemming and an EN-SL glossary) runs in the browser; only the top passages go to Gemini, which must cite every claim. Includes a retrieval test set. |
| `/ai-act-check/` | **AI Act & GDPR check**: runs the [ai-compliance-check](https://github.com/egorperp/ai-compliance-check) skill on Gemini. |
| `/cebelca/` | **Čebelca MCP playground**: Gemini function calling against demo data with the same tools as [cebelca-mcp](https://github.com/egorperp/cebelca-mcp). |

## How it works

```
browser ── static pages (public/) ──┐
        └─ POST /api/gemini ─────── src/worker.js ── Google Gemini API
```

`src/worker.js` is the only server code. It keeps the Gemini API key secret, fixes the model, accepts same-origin requests only, limits size and rate (20 requests per minute per IP with the Workers Rate Limiting binding) and stores nothing.

Documents uploaded on `/ask/` are parsed in the browser (pdf.js, mammoth) and never stored.

## Run and deploy

```bash
npm install
echo 'GEMINI_API_KEY=your-key' > .dev.vars   # free key: https://aistudio.google.com/apikey
npx wrangler dev
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

Or connect the repository in the Cloudflare dashboard (Workers → Create → Import a repository) and add `GEMINI_API_KEY` as a secret.

MIT License
