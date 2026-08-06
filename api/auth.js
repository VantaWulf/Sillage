/**
 * POST /api/auth  { action: "register"|"login", ... }
 * Cloud accounts shared across phones.
 */

const crypto = require("crypto");
const {
  json,
  readBody,
  handleOptions,
  normalizeHandle,
  normalizeEmail,
  hashPassword,
  getUserByHandle,
  getUserByEmail,
  saveUser,
  publicUser,
  signToken,
  getFollows,
  saveFollows,
} = require("./_cloud");

function uid() {
  return crypto.randomBytes(12).toString("hex");
}

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });

  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: "Invalid JSON" });
  }

  const action = String(body.action || "").toLowerCase();

  try {
    if (action === "register") {
      const handle = normalizeHandle(body.handle);
      const email = normalizeEmail(body.email);
      const name = String(body.name || handle).trim().slice(0, 40) || handle;
      const password = String(body.password || "");

      if (handle.length < 3) {
        return json(res, 400, { error: "Username must be at least 3 characters." });
      }
      if (!email.includes("@")) {
        return json(res, 400, { error: "Enter a valid email." });
      }
      if (password.length < 6) {
        return json(res, 400, { error: "Password must be at least 6 characters." });
      }
      if (await getUserByHandle(handle)) {
        return json(res, 409, { error: "That username is taken." });
      }
      if (await getUserByEmail(email)) {
        return json(res, 409, { error: "That email is already registered." });
      }

      const salt = uid();
      const user = {
        id: uid(),
        name,
        handle,
        email,
        passwordHash: hashPassword(password, salt),
        salt,
        createdAt: new Date().toISOString(),
      };
      await saveUser(user);
      await saveFollows(user.id, { following: [], followers: [] });

      const token = signToken(user.id);
      return json(res, 200, {
        ok: true,
        token,
        user: publicUser(user),
      });
    }

    if (action === "login") {
      const key = String(body.handleOrEmail || body.handle || body.email || "")
        .trim()
        .toLowerCase();
      const password = String(body.password || "");
      if (!key) return json(res, 400, { error: "Enter your username or email." });
      if (!password) return json(res, 400, { error: "Enter your password." });

      let user =
        (await getUserByHandle(key)) ||
        (key.includes("@") ? await getUserByEmail(key) : null);
      if (!user) {
        return json(res, 404, {
          error:
            "No cloud account with that username/email. Create an account on any device first.",
        });
      }
      const passwordHash = hashPassword(password, user.salt);
      if (passwordHash !== user.passwordHash) {
        return json(res, 401, { error: "Wrong password." });
      }

      // ensure follows file exists
      const f = await getFollows(user.id);
      await saveFollows(user.id, f);

      return json(res, 200, {
        ok: true,
        token: signToken(user.id),
        user: publicUser(user),
      });
    }

    return json(res, 400, { error: "Unknown action. Use register or login." });
  } catch (e) {
    const status = e.code === "NO_CLOUD" ? 503 : 500;
    return json(res, status, {
      error: e.message || String(e),
      cloud: e.code !== "NO_CLOUD",
    });
  }
};
