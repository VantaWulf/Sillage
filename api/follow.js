/**
 * POST /api/follow  { token, handle | userId, action?: "follow"|"unfollow" }
 * GET  /api/follow?token=  → my following / followers / friends
 */

const {
  json,
  readBody,
  handleOptions,
  tokenFromReq,
  verifyToken,
  normalizeHandle,
  getUserById,
  getUserByHandle,
  getFollows,
  saveFollows,
  publicUser,
} = require("./_cloud");

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;

  try {
    if (req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const token = url.searchParams.get("token") || "";
      const userId = verifyToken(token);
      if (!userId) return json(res, 401, { error: "Log in required." });

      const mine = await getFollows(userId);
      const following = [];
      const followers = [];
      const friends = [];

      for (const id of mine.following || []) {
        const u = publicUser(await getUserById(id));
        if (u) following.push(u);
      }
      for (const id of mine.followers || []) {
        const u = publicUser(await getUserById(id));
        if (u) followers.push(u);
      }
      for (const id of mine.following || []) {
        const them = await getFollows(id);
        if ((them.following || []).includes(userId)) {
          const u = publicUser(await getUserById(id));
          if (u) friends.push(u);
        }
      }

      return json(res, 200, { ok: true, following, followers, friends });
    }

    if (req.method !== "POST") return json(res, 405, { error: "GET or POST only" });

    const body = await readBody(req);
    const token = tokenFromReq(req, body);
    const userId = verifyToken(token);
    if (!userId) return json(res, 401, { error: "Log in required." });

    const action = String(body.action || "follow").toLowerCase();
    let target = null;
    if (body.userId) target = await getUserById(body.userId);
    else if (body.handle) target = await getUserByHandle(normalizeHandle(body.handle));
    if (!target) return json(res, 404, { error: "User not found." });
    if (target.id === userId) {
      return json(res, 400, { error: "You can’t follow yourself." });
    }

    const mine = await getFollows(userId);
    const theirs = await getFollows(target.id);

    if (action === "unfollow") {
      mine.following = (mine.following || []).filter((x) => x !== target.id);
      theirs.followers = (theirs.followers || []).filter((x) => x !== userId);
    } else {
      if (!(mine.following || []).includes(target.id)) {
        mine.following = [...(mine.following || []), target.id];
      }
      if (!(theirs.followers || []).includes(userId)) {
        theirs.followers = [...(theirs.followers || []), userId];
      }
    }

    await saveFollows(userId, mine);
    await saveFollows(target.id, theirs);

    const mutual =
      (mine.following || []).includes(target.id) &&
      (theirs.following || []).includes(userId);

    return json(res, 200, {
      ok: true,
      action: action === "unfollow" ? "unfollow" : "follow",
      user: publicUser(target),
      friends: mutual,
      following: (mine.following || []).includes(target.id),
    });
  } catch (e) {
    const status = e.code === "NO_CLOUD" ? 503 : 500;
    return json(res, status, { error: e.message || String(e) });
  }
};
