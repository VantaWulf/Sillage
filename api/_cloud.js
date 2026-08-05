/**
 * Shared helpers for Sillage cloud (Supabase Storage + simple HMAC sessions).
 * Used by /api/auth, /api/posts, /api/follow, /api/people.
 */

const crypto = require("crypto");

const BUCKET = "sillage";
const POST_TTL_MS = 72 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function env(name) {
  return (process.env[name] || "").trim();
}

function supabaseConfig() {
  const url = env("SUPABASE_URL").replace(/\/$/, "");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    const err = new Error("Cloud not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
    err.code = "NO_CLOUD";
    throw err;
  }
  return { url, key };
}

function sessionSecret() {
  return env("SILLAGE_SESSION_SECRET") || env("SUPABASE_SERVICE_ROLE_KEY") || "sillage-dev";
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-sillage-token"
  );
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

function handleOptions(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    cors(res);
    res.end();
    return true;
  }
  return false;
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64url(s) {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(b64, "base64");
}

function signToken(userId) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = b64url(JSON.stringify({ uid: userId, exp }));
  const sig = b64url(
    crypto.createHmac("sha256", sessionSecret()).update(payload).digest()
  );
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, sig] = token.split(".");
  const expect = b64url(
    crypto.createHmac("sha256", sessionSecret()).update(payload).digest()
  );
  if (sig !== expect) return null;
  try {
    const data = JSON.parse(fromB64url(payload).toString("utf8"));
    if (!data.uid || !data.exp || Date.now() > data.exp) return null;
    return data.uid;
  } catch {
    return null;
  }
}

function tokenFromReq(req, body = {}) {
  const h =
    req.headers["x-sillage-token"] ||
    req.headers["authorization"] ||
    "";
  if (typeof h === "string" && h.toLowerCase().startsWith("bearer ")) {
    return h.slice(7).trim();
  }
  if (typeof h === "string" && h && !h.toLowerCase().startsWith("bearer")) {
    return h.trim();
  }
  return body.token || "";
}

async function sbFetch(path, { method = "GET", body, contentType, rawBody } = {}) {
  const { url, key } = supabaseConfig();
  const headers = {
    Authorization: `Bearer ${key}`,
    apikey: key,
  };
  if (contentType) headers["Content-Type"] = contentType;
  else if (body !== undefined && !rawBody) headers["Content-Type"] = "application/json";

  const res = await fetch(`${url}${path}`, {
    method,
    headers,
    body: rawBody
      ? body
      : body !== undefined
        ? JSON.stringify(body)
        : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data, text };
}

async function ensureBucket() {
  const { status } = await sbFetch(`/storage/v1/bucket/${BUCKET}`);
  if (status === 200) return;
  await sbFetch("/storage/v1/bucket", {
    method: "POST",
    body: {
      id: BUCKET,
      name: BUCKET,
      public: true,
      file_size_limit: 10485760,
    },
  });
}

async function storageUpload(path, buffer, contentType) {
  await ensureBucket();
  const { ok, status, text } = await sbFetch(
    `/storage/v1/object/${BUCKET}/${path}`,
    {
      method: "POST",
      contentType: contentType || "application/octet-stream",
      rawBody: true,
      body: buffer,
    }
  );
  // upsert if exists
  if (!ok && status === 400) {
    const up = await sbFetch(`/storage/v1/object/${BUCKET}/${path}`, {
      method: "PUT",
      contentType: contentType || "application/octet-stream",
      rawBody: true,
      body: buffer,
    });
    if (!up.ok) throw new Error(`Storage upload failed: ${up.status} ${up.text}`);
    return;
  }
  if (!ok) throw new Error(`Storage upload failed: ${status} ${text}`);
}

async function storageDownload(path) {
  const { url, key } = supabaseConfig();
  const res = await fetch(`${url}/storage/v1/object/${BUCKET}/${path}`, {
    headers: { Authorization: `Bearer ${key}`, apikey: key },
  });
  // Missing objects may be 404 or 400 depending on Storage version
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Storage download failed: ${res.status} ${t.slice(0, 120)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const ctype = res.headers.get("content-type") || "";
  return { buf, contentType: ctype };
}

async function storageReadJson(path) {
  const file = await storageDownload(path);
  if (!file) return null;
  return JSON.parse(file.buf.toString("utf8"));
}

async function storageWriteJson(path, obj) {
  const buf = Buffer.from(JSON.stringify(obj), "utf8");
  await storageUpload(path, buf, "application/json");
}

async function storageList(prefix) {
  await ensureBucket();
  const { ok, data, status, text } = await sbFetch(
    `/storage/v1/object/list/${BUCKET}`,
    {
      method: "POST",
      body: {
        prefix: prefix || "",
        limit: 1000,
        offset: 0,
        sortBy: { column: "name", order: "desc" },
      },
    }
  );
  if (!ok) throw new Error(`Storage list failed: ${status} ${text}`);
  return Array.isArray(data) ? data : [];
}

function publicObjectUrl(path) {
  const { url } = supabaseConfig();
  return `${url}/storage/v1/object/public/${BUCKET}/${path}`;
}

function normalizeHandle(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 24);
}

function normalizeEmail(e) {
  return String(e || "").trim().toLowerCase();
}

function hashPassword(password, salt) {
  return crypto
    .createHash("sha256")
    .update(`${salt}:${password}`)
    .digest("hex");
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    handle: u.handle,
    bio: u.bio || "Sillage member",
    createdAt: u.createdAt,
  };
}

async function getUserById(id) {
  if (!id) return null;
  return storageReadJson(`users/by-id/${id}.json`);
}

async function getUserByHandle(handle) {
  const h = normalizeHandle(handle);
  if (!h) return null;
  const idx = await storageReadJson(`users/by-handle/${h}.json`);
  if (!idx?.id) return null;
  return getUserById(idx.id);
}

async function getUserByEmail(email) {
  const em = normalizeEmail(email);
  if (!em) return null;
  const idx = await storageReadJson(`users/by-email/${encodeURIComponent(em)}.json`);
  if (!idx?.id) return null;
  return getUserById(idx.id);
}

async function saveUser(user) {
  await storageWriteJson(`users/by-id/${user.id}.json`, user);
  await storageWriteJson(`users/by-handle/${user.handle}.json`, { id: user.id });
  await storageWriteJson(`users/by-email/${encodeURIComponent(user.email)}.json`, {
    id: user.id,
  });
}

async function getFollows(userId) {
  const data = await storageReadJson(`follows/${userId}.json`);
  return {
    following: Array.isArray(data?.following) ? data.following : [],
    followers: Array.isArray(data?.followers) ? data.followers : [],
  };
}

async function saveFollows(userId, follows) {
  await storageWriteJson(`follows/${userId}.json`, {
    following: follows.following || [],
    followers: follows.followers || [],
    updatedAt: new Date().toISOString(),
  });
}

function isExpiredPost(createdAt) {
  const t = new Date(createdAt).getTime();
  if (!Number.isFinite(t)) return true;
  return Date.now() - t >= POST_TTL_MS;
}

function parseDataUrl(dataUrl) {
  const m = String(dataUrl || "").match(
    /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/
  );
  if (!m) return null;
  return { contentType: m[1], buffer: Buffer.from(m[2], "base64") };
}

module.exports = {
  BUCKET,
  POST_TTL_MS,
  cors,
  json,
  readBody,
  handleOptions,
  signToken,
  verifyToken,
  tokenFromReq,
  publicObjectUrl,
  normalizeHandle,
  normalizeEmail,
  hashPassword,
  publicUser,
  getUserById,
  getUserByHandle,
  getUserByEmail,
  saveUser,
  getFollows,
  saveFollows,
  isExpiredPost,
  parseDataUrl,
  storageUpload,
  storageReadJson,
  storageWriteJson,
  storageList,
  supabaseConfig,
  ensureBucket,
};
