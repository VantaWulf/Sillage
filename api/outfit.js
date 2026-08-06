/**
 * POST /api/outfit
 * Body: { "image": "data:image/jpeg;base64,..." }
 * → { items: [ { id, category, name, color, brandGuess, material, shopQuery, shops: [{name,url}] } ] }
 *
 * Uses xAI vision to identify clothing pieces, then builds shop-search links
 * (Google Shopping / Amazon / etc.) so viewers can find similar items.
 */

const XAI_CHAT = "https://api.x.ai/v1/chat/completions";

const SYSTEM = `You are a fashion stylist AI. Look at an outfit photo (person may be a mannequin).
Identify each DISTINCT clothing/accessory piece the person is wearing.

Return ONLY valid JSON (no markdown):
{
  "items": [
    {
      "category": "top|bottom|dress|outerwear|shoes|bag|hat|jewelry|belt|other",
      "name": "short plain name e.g. White crew-neck tee",
      "color": "main color",
      "brandGuess": "brand if logo visible else empty string",
      "material": "fabric guess or empty",
      "shopQuery": "search keywords for buying a similar item (include color + type + style, no personal names)"
    }
  ]
}

Rules:
- 2–8 items max; skip skin, face, room objects, fragrance bottles unless clearly held as product.
- Prefer separable garments (jacket, shirt, jeans, sneakers) over one vague "outfit".
- shopQuery must be useful for Google Shopping (e.g. "beige wide leg linen trousers women").
- If unsure of brand, leave brandGuess "".`;

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

function shopLinks(shopQuery, brandGuess) {
  const q = [shopQuery, brandGuess].filter(Boolean).join(" ").trim() || "clothing";
  const enc = encodeURIComponent(q);
  return [
    {
      name: "Google Shopping",
      url: `https://www.google.com/search?tbm=shop&q=${enc}`,
    },
    {
      name: "Amazon",
      url: `https://www.amazon.com/s?k=${enc}`,
    },
    {
      name: "Nordstrom",
      url: `https://www.nordstrom.com/sr?keyword=${enc}`,
    },
    {
      name: "ASOS",
      url: `https://www.asos.com/us/search/?q=${enc}`,
    },
  ];
}

function normalizeItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  const out = [];
  for (let i = 0; i < rawItems.length && out.length < 8; i += 1) {
    const it = rawItems[i] || {};
    const name = String(it.name || it.category || "Item").trim().slice(0, 80);
    const shopQuery = String(it.shopQuery || name).trim().slice(0, 120);
    if (!name) continue;
    const brandGuess = String(it.brandGuess || "").trim().slice(0, 40);
    out.push({
      id: `oi_${i}_${Math.random().toString(36).slice(2, 7)}`,
      category: String(it.category || "other").toLowerCase().slice(0, 24),
      name,
      color: String(it.color || "").trim().slice(0, 40),
      brandGuess,
      material: String(it.material || "").trim().slice(0, 40),
      shopQuery,
      shops: shopLinks(shopQuery, brandGuess),
    });
  }
  return out;
}

function extractJson(text) {
  const s = String(text || "").trim();
  try {
    return JSON.parse(s);
  } catch {
    /* try fenced or substring */
  }
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* continue */
    }
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(s.slice(start, end + 1));
  }
  throw new Error("Model did not return JSON");
}

async function identifyOutfit(dataUrl, apiKey) {
  // Multimodal chat models (account-specific vision SKUs often missing)
  const models = [
    process.env.SILLAGE_VISION_MODEL || "grok-4.20-0309-non-reasoning",
    "grok-4.5",
    "grok-4.3",
    "grok-4.20-0309-reasoning",
  ];
  let lastErr = null;

  for (const model of models) {
    try {
      const res = await fetch(XAI_CHAT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: 1200,
          messages: [
            { role: "system", content: SYSTEM },
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: dataUrl },
                },
                {
                  type: "text",
                  text: "Identify each clothing and accessory piece and return JSON only.",
                },
              ],
            },
          ],
        }),
      });
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`xAI non-JSON (${res.status}): ${text.slice(0, 200)}`);
      }
      if (!res.ok) {
        const msg = body.error?.message || body.error || text.slice(0, 200);
        const err = new Error(`xAI HTTP ${res.status}: ${msg}`);
        err.status = res.status;
        throw err;
      }
      const content =
        body.choices?.[0]?.message?.content ||
        body.choices?.[0]?.message?.reasoning_content ||
        "";
      const parsed = extractJson(content);
      return {
        items: normalizeItems(parsed.items || parsed.pieces || []),
        model,
      };
    } catch (e) {
      lastErr = e;
      // try next model if 404 model missing
      if (e.status === 404 || /model/i.test(e.message || "")) continue;
      throw e;
    }
  }
  throw lastErr || new Error("Vision model unavailable");
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    cors(res);
    res.end();
    return;
  }
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });

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
    return json(res, 413, { error: "Image too large" });
  }

  const apiKey = loadKey();
  if (!apiKey) {
    return json(res, 503, {
      error: "XAI_API_KEY not configured",
      items: [],
      fallback: true,
    });
  }

  try {
    const result = await identifyOutfit(image, apiKey);
    return json(res, 200, {
      ok: true,
      items: result.items,
      model: result.model,
      engine: "xai-vision",
    });
  } catch (e) {
    return json(res, 502, {
      error: e.message || String(e),
      items: [],
      fallback: true,
    });
  }
};
