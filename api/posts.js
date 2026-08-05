/**
 * GET  /api/posts  — feed (token optional; public posts always, friends if logged in)
 * POST /api/posts  — create post { token, fragranceId, fragranceName, fragranceBrand, noFragrance, privacy, image }
 */

const crypto = require("crypto");
const {
  json,
  readBody,
  handleOptions,
  tokenFromReq,
  verifyToken,
  getUserById,
  getFollows,
  isExpiredPost,
  parseDataUrl,
  storageUpload,
  storageWriteJson,
  storageList,
  storageReadJson,
  publicObjectUrl,
  publicUser,
  POST_TTL_MS,
} = require("./_cloud");

function uid() {
  return crypto.randomBytes(10).toString("hex");
}

async function loadAllPosts() {
  const files = await storageList("posts/");
  const posts = [];
  for (const f of files) {
    const name = f.name || f;
    if (!String(name).endsWith(".json")) continue;
    const path = `posts/${name}`;
    try {
      const p = await storageReadJson(path);
      if (p && p.id && !isExpiredPost(p.createdAt)) posts.push(p);
    } catch {
      /* skip bad files */
    }
  }
  posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return posts;
}

function canSee(post, viewerId, followingSet) {
  if (post.privacy === "public") return true;
  if (!viewerId) return false;
  if (post.userId === viewerId) return true;
  // friends = mutual follow
  return followingSet.has(post.userId);
}

async function friendIds(viewerId) {
  if (!viewerId) return new Set();
  const me = await getFollows(viewerId);
  const following = new Set(me.following || []);
  const friends = new Set();
  for (const otherId of following) {
    const them = await getFollows(otherId);
    if ((them.following || []).includes(viewerId)) friends.add(otherId);
  }
  return friends;
}

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;

  try {
    if (req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const token = url.searchParams.get("token") || "";
      const viewerId = verifyToken(token);
      const friends = await friendIds(viewerId);
      // also treat one-way following as able to see? Spec said mutual = friends.
      // For feed usefulness, friends-only visible if mutual friends.
      const followingSet = friends;

      const posts = await loadAllPosts();
      const out = [];
      for (const p of posts) {
        if (!canSee(p, viewerId, followingSet)) continue;
        const author = await getUserById(p.userId);
        out.push({
          id: p.id,
          userId: p.userId,
          fragranceId: p.fragranceId,
          fragranceName: p.fragranceName,
          fragranceBrand: p.fragranceBrand,
          noFragrance: !!p.noFragrance,
          privacy: p.privacy,
          imageUrl: p.imageUrl,
          createdAt: p.createdAt,
          author: publicUser(author),
        });
      }
      return json(res, 200, {
        ok: true,
        posts: out.slice(0, 100),
        ttlMs: POST_TTL_MS,
        cloud: true,
      });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const token = tokenFromReq(req, body);
      const userId = verifyToken(token);
      if (!userId) return json(res, 401, { error: "Log in to post for friends." });
      const user = await getUserById(userId);
      if (!user) return json(res, 401, { error: "Account not found. Log in again." });

      const privacy = body.privacy === "public" ? "public" : "friends";
      const noFragrance = !!body.noFragrance || body.fragranceId === "__none__";
      const image = body.image || body.imageDataUrl || "";
      const parsed = parseDataUrl(image);
      if (!parsed) {
        return json(res, 400, { error: "Expected outfit image data URL." });
      }
      if (parsed.buffer.length > 9_000_000) {
        return json(res, 413, { error: "Image too large." });
      }

      const id = uid();
      const createdAt = new Date().toISOString();
      const ext = (parsed.contentType.split("/")[1] || "jpg").replace("jpeg", "jpg");
      const imagePath = `images/${userId}/${id}.${ext}`;
      await storageUpload(imagePath, parsed.buffer, parsed.contentType);
      const imageUrl = publicObjectUrl(imagePath);

      const post = {
        id,
        userId,
        fragranceId: noFragrance ? "__none__" : String(body.fragranceId || ""),
        fragranceName: noFragrance
          ? "no fragrance"
          : String(body.fragranceName || body.fragranceId || "Fragrance"),
        fragranceBrand: noFragrance ? "" : String(body.fragranceBrand || ""),
        noFragrance,
        privacy,
        imageUrl,
        imagePath,
        createdAt,
      };
      // name sorts newest first when listing desc by name if we prefix timestamp
      const stamp = createdAt.replace(/[:.]/g, "-");
      await storageWriteJson(`posts/${stamp}_${id}.json`, post);

      return json(res, 200, {
        ok: true,
        post: {
          ...post,
          author: publicUser(user),
        },
      });
    }

    return json(res, 405, { error: "GET or POST only" });
  } catch (e) {
    const status = e.code === "NO_CLOUD" ? 503 : 500;
    return json(res, status, { error: e.message || String(e) });
  }
};
