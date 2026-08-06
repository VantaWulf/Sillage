/**
 * GET /api/people?q=handle&token=
 * Search cloud users by username (prefix / contains).
 */

const {
  json,
  handleOptions,
  verifyToken,
  normalizeHandle,
  storageList,
  storageReadJson,
  publicUser,
  getUserById,
  getFollows,
} = require("./_cloud");

module.exports = async function handler(req, res) {
  if (handleOptions(req, res)) return;
  if (req.method !== "GET") return json(res, 405, { error: "GET only" });

  try {
    const url = new URL(req.url, "http://localhost");
    const q = normalizeHandle(url.searchParams.get("q") || "");
    const token = url.searchParams.get("token") || "";
    const viewerId = verifyToken(token);

    const files = await storageList("users/by-handle/");
    const people = [];
    for (const f of files) {
      const name = String(f.name || f);
      if (!name.endsWith(".json")) continue;
      const handle = name.replace(/\.json$/, "");
      if (q && !handle.includes(q)) continue;
      const idx = await storageReadJson(`users/by-handle/${handle}.json`);
      if (!idx?.id) continue;
      if (viewerId && idx.id === viewerId) continue;
      const u = publicUser(await getUserById(idx.id));
      if (u) people.push(u);
      if (people.length >= 40) break;
    }

    people.sort((a, b) => a.handle.localeCompare(b.handle));

    let following = new Set();
    let friends = new Set();
    if (viewerId) {
      const mine = await getFollows(viewerId);
      following = new Set(mine.following || []);
      for (const id of following) {
        const them = await getFollows(id);
        if ((them.following || []).includes(viewerId)) friends.add(id);
      }
    }

    return json(res, 200, {
      ok: true,
      people: people.map((p) => ({
        ...p,
        isFollowing: following.has(p.id),
        isFriend: friends.has(p.id),
      })),
    });
  } catch (e) {
    const status = e.code === "NO_CLOUD" ? 503 : 500;
    return json(res, status, { error: e.message || String(e) });
  }
};
