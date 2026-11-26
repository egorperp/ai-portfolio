/**
 * yegor-ai: portfolio + AI tools on Cloudflare Workers.
 *
 * Static pages are served from ./public. The only server route is POST /api/gemini,
 * a narrow proxy to Google Gemini that:
 *  - keeps the API key on the server (secret GEMINI_API_KEY),
 *  - fixes the model (with automatic fallback to another Flash model when one is overloaded),
 *  - accepts only same-origin requests with a size limit,
 *  - rate-limits per IP (Workers Rate Limiting binding),
 *  - stores nothing: no logs of prompts or documents.
 */
const MAX_BODY = 300_000;
const ALLOWED_KEYS = ["contents", "systemInstruction", "tools", "generationConfig"];
const API = "https://generativelanguage.googleapis.com/v1beta";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

// Preferred model first, then other Flash models this key can use (newest first). Cached per isolate for an hour.
let modelCache = null;
async function candidateModels(env) {
  const preferred = env.GEMINI_MODEL || "gemini-3.8-flash";
  if (!modelCache || Date.now() - modelCache.at > 3_600_000) {
    let names = [];
    try {
      const r = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": env.GEMINI_API_KEY } });
      const j = await r.json();
      names = (j.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, ""))
        .filter((n) => /flash/.test(n) && !/(image|tts|audio|live|embed|exp)/.test(n))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch {}
    modelCache = { at: Date.now(), names };
  }
  return [preferred, ...modelCache.names.filter((n) => n !== preferred)].slice(0, 4);
}

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
  payload.generationConfig = { ...(payload.generationConfig || {}), maxOutputTokens: 4096 };

  let last = null;
  for (const model of await candidateModels(env)) {
    const upstream = await fetch(`${API}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify(payload),
    });
    const data = await upstream.json().catch(() => ({}));
    if (upstream.ok) return json({ candidates: data.candidates, usageMetadata: data.usageMetadata, modelVersion: data.modelVersion || model });
    last = { status: upstream.status, detail: String(data?.error?.message || "").slice(0, 200) };
    console.log("gemini error", model, last.status, last.detail);
    if (![404, 429, 500, 503].includes(upstream.status)) break; // other errors would fail on every model
  }
  const busy = last && [429, 503].includes(last.status);
  return json(
    { error: busy ? "The AI models are busy right now. Please try again in a minute." : `The AI service returned an error (${last?.status}${last?.detail ? ": " + last.detail : ""}).` },
    busy ? 429 : 502,
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/gemini") return gemini(request, env);
    if (url.pathname === "/api/health") {
      const models = env.GEMINI_API_KEY ? await candidateModels(env) : [];
      return json({ ok: true, ai: Boolean(env.GEMINI_API_KEY), models });
    }
    return env.ASSETS.fetch(request);
  },
};
