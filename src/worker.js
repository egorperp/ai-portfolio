/**
 * yegor-ai: portfolio + AI tools on Cloudflare Workers.
 *
 * Static pages are served from ./public. The only server route is POST /api/gemini,
 * a narrow proxy to Google Gemini that:
 *  - keeps the API key on the server (secret GEMINI_API_KEY),
 *  - fixes the model, so the endpoint cannot be used for anything else,
 *  - accepts only same-origin requests with a size limit,
 *  - rate-limits per IP (Workers Rate Limiting binding),
 *  - stores nothing: no logs of prompts or documents.
 */
const MAX_BODY = 300_000;
const ALLOWED_KEYS = ["contents", "systemInstruction", "tools", "generationConfig"];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function gemini(request, env) {
  if (request.method !== "POST") return json({ error: "Use POST." }, 405);
  if (!env.GEMINI_API_KEY) return json({ error: "The AI service is not configured yet." }, 503);

  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: "Forbidden." }, 403);

  if (env.LIMITER) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const { success } = await env.LIMITER.limit({ key: ip });
    if (!success) return json({ error: "Too many requests. Please wait a minute and try again." }, 429);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: "Request too large." }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: "Invalid JSON." }, 400); }
  if (!Array.isArray(body.contents) || !body.contents.length) return json({ error: "Missing contents." }, 400);

  const payload = {};
  for (const k of ALLOWED_KEYS) if (body[k] !== undefined) payload[k] = body[k];
  payload.generationConfig = { ...(payload.generationConfig || {}), maxOutputTokens: 2048 };

  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify(payload),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const status = upstream.status === 429 ? 429 : 502;
    const detail = String(data?.error?.message || "").slice(0, 200);
    console.log("gemini error", upstream.status, detail);
    return json({ error: status === 429 ? "The free AI quota is busy right now. Please try again in a minute." : `The AI service returned an error (${upstream.status}${detail ? ": " + detail : ""}).` }, status);
  }
  return json({ candidates: data.candidates, usageMetadata: data.usageMetadata, modelVersion: data.modelVersion });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/gemini") return gemini(request, env);
    if (url.pathname === "/api/health") return json({ ok: true, ai: Boolean(env.GEMINI_API_KEY) });
    return env.ASSETS.fetch(request);
  },
};
