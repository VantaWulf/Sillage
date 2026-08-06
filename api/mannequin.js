/**
 * POST /api/mannequin — AI privacy mannequin (xAI Grok Imagine image edit)
 * Body: { "image": "data:image/jpeg;base64,..." }
 * → { "image": "data:image/jpeg;base64,...", "engine": "xai-imagine" }
 *
 * Mirrors server.py for local; runs on Vercel like Hermes /api/plan.
 */

const XAI_EDITS = "https://api.x.ai/v1/images/edits";

const MANNEQUIN_PROMPT =
  "Edit this full-body outfit selfie carefully. " +
  "Replace ONLY the person's body identity — face, skin, hair, and bare skin — " +
  "with a smooth featureless fashion mannequin made of matte beige plastic " +
  "(blank mannequin head with no eyes, no mouth, no hair; smooth mannequin hands). " +
  "Keep the EXACT same clothing and outfit completely untouched: same colors, " +
  "fabric, logos, wrinkles, fit, and silhouette. " +
  "Keep the same pose, camera angle, and room background unchanged. " +
  "Photorealistic. Do not change the clothes. Do not add text or watermarks.";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  cors(res);
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function loadKey() {
  return (process.env.XAI_API_KEY || "").trim();
}

async function callXaiMannequin(dataUrl, apiKey) {
  const payload = {
    model: "grok-imagine-image-quality",
    prompt: MANNEQUIN_PROMPT,
    image: {
      url: dataUrl,
      type: "image_url",
    },
    n: 1,
  };

  const res = await fetch(XAI_EDITS, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`xAI non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const err = new Error(`xAI HTTP ${res.status}`);
    err.detail = text.slice(0, 800);
    err.status = res.status;
    throw err;
  }

  const items = body.data || [];
  if (!items.length && body.url) {
    return { url: body.url };
  }
  if (!items.length) {
    throw new Error(`Unexpected xAI response keys: ${Object.keys(body).join(",")}`);
  }

  const item = items[0];
  if (item.b64_json) {
    return { image: `data:image/jpeg;base64,${item.b64_json}` };
  }
  if (item.url) {
    try {
      const imgRes = await fetch(item.url, {
        headers: { "User-Agent": "SillageMannequin/1.0" },
      });
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const ctype = imgRes.headers.get("content-type") || "image/jpeg";
      return {
        image: `data:${ctype};base64,${buf.toString("base64")}`,
        url: item.url,
      };
    } catch (fetchErr) {
      return { url: item.url, fetch_warning: String(fetchErr.message || fetchErr) };
    }
  }
  throw new Error("No image in xAI response");
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    cors(res);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    return json(res, 405, { error: "POST only" });
  }

  let data;
  try {
    data = await readBody(req);
  } catch {
    return json(res, 400, { error: "Invalid JSON" });
  }

  const image = data.image || "";
  if (typeof image !== "string" || !image.startsWith("data:image")) {
    return json(res, 400, { error: "Expected image data URL" });
  }
  if (image.length > 12_000_000) {
    return json(res, 413, { error: "Image too large — try a smaller photo" });
  }

  const apiKey = loadKey();
  if (!apiKey) {
    return json(res, 503, {
      error: "XAI_API_KEY not configured",
      fallback: true,
      hint: "Set XAI_API_KEY in Vercel project env (Production + Preview)",
    });
  }

  try {
    const result = await callXaiMannequin(image, apiKey);
    return json(res, 200, { ...result, engine: "xai-imagine" });
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? 502 : 500;
    return json(res, status, {
      error: e.message || String(e),
      detail: e.detail || undefined,
      fallback: true,
    });
  }
};
