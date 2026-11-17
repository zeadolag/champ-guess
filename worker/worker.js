// Leagledle server: Discord login, live progress and leaderboards.
// Runs as a Cloudflare Worker with a D1 database bound as DB.
// Settings it needs (Worker → Settings → Variables and Secrets):
//   DISCORD_CLIENT_ID      (text)    your Discord Application ID
//   DISCORD_CLIENT_SECRET  (secret)  from the Discord Developer Portal → OAuth2
//   SESSION_KEY            (secret)  any long random text, used to sign logins

const MODES = new Set(["classic", "ability", "splash", "quote", "emoji", "item"]);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Scoring: 100 for finishing, minus 10 per wrong guess (never below 10).
// In Ability mode, turning off grayscale or rotation each costs 20% of that,
// and naming the right ability (Passive/Q/W/E/R) afterwards adds 20.
const HELPS = new Set(["color", "upright"]);
function score(mode, guesses, helps) {
  let p = Math.max(10, 100 - 10 * (Math.max(1, guesses) - 1));
  if (mode === "ability") for (const h of new Set(helps)) if (HELPS.has(h)) p *= 0.8;
  return Math.round(p);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // Discord's proxy may or may not keep the /api prefix, so accept both.
    const path = url.pathname.replace(/^\/(\.proxy\/)?api/, "") || "/";
    if (req.method === "OPTIONS") return new Response(null, { headers: cors() });
    try {
      if (path === "/token" && req.method === "POST") return await token(req, env);
      if (path === "/progress" && req.method === "POST") return await progress(req, env);
      if (path === "/live" && req.method === "GET") return await live(url, env);
      if (path === "/board" && req.method === "GET") return await board(url, env);
      if (path === "/recap" && req.method === "GET") return await recap(url, env);
      if (path === "/" ) return json({ ok: true, name: "Leagledle API" });
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },
};

// ---------- login ----------
async function token(req, env) {
  const { code } = await req.json();
  if (!code) return json({ error: "missing code" }, 400);
  const r = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
    }),
  });
  const t = await r.json();
  if (!t.access_token) return json({ error: "token exchange failed", detail: t.error || null }, 400);
  const me = await (await fetch("https://discord.com/api/users/@me", { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
  if (!me.id) return json({ error: "could not read user" }, 400);
  const name = me.global_name || me.username;
  await env.DB.prepare(
    "INSERT INTO users (id, name, avatar) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET name = ?2, avatar = ?3"
  ).bind(me.id, name, me.avatar || null).run();
  const session = await sign(env, { uid: me.id, exp: Date.now() + 30 * 864e5 });
  return json({ access_token: t.access_token, session, user: { id: me.id, name, avatar: me.avatar || null } });
}

// ---------- saving progress ----------
async function progress(req, env) {
  const uid = await auth(req, env);
  if (!uid) return json({ error: "not logged in" }, 401);
  const b = await req.json();
  if (!MODES.has(b.mode) || !DAY_RE.test(b.day || "")) return json({ error: "bad mode or day" }, 400);
  const guesses = clampInt(b.guesses, 0, 200), done = b.done ? 1 : 0;
  const started = clampInt(b.started, 0, 9e15) || Date.now();
  const finished = done ? (clampInt(b.finished, 0, 9e15) || Date.now()) : null;
  const channel = str(b.channel), guild = str(b.guild);
  const helps = Array.isArray(b.helps) ? b.helps.filter(h => HELPS.has(h)) : [];
  const bonus = done && b.mode === "ability" && (b.bonus === 0 || b.bonus === 1) ? b.bonus : null;
  const points = done ? score(b.mode, guesses, helps) + (bonus === 1 ? 20 : 0) : 0;
  // Once a day's puzzle is finished it can't be changed again.
  await env.DB.prepare(
    `INSERT INTO plays (user_id, mode, day, channel_id, guild_id, guesses, done, started_at, finished_at, updated_at, points, bonus)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT(user_id, mode, day) DO UPDATE SET
       guesses = CASE WHEN plays.done = 1 THEN plays.guesses ELSE ?6 END,
       points = CASE WHEN plays.done = 1 THEN plays.points + CASE WHEN plays.bonus IS NULL AND ?12 = 1 THEN 20 ELSE 0 END ELSE ?11 END,
       bonus = CASE WHEN plays.bonus IS NULL THEN ?12 ELSE plays.bonus END,
       finished_at = CASE WHEN plays.done = 1 THEN plays.finished_at ELSE ?9 END,
       done = MAX(plays.done, ?7),
       channel_id = COALESCE(plays.channel_id, ?4),
       guild_id = COALESCE(plays.guild_id, ?5),
       updated_at = ?10`
  ).bind(uid, b.mode, b.day, channel, guild, guesses, done, started, finished, Date.now(), points, bonus).run();
  return json({ ok: true });
}

// ---------- today's live list ----------
async function live(url, env) {
  const mode = url.searchParams.get("mode"), day = url.searchParams.get("day");
  const scope = url.searchParams.get("scope") === "server" ? "guild_id" : "channel_id";
  const id = str(url.searchParams.get("id"));
  if (!MODES.has(mode) || !DAY_RE.test(day || "") || !id) return json({ error: "bad query" }, 400);
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.avatar, p.guesses, p.done, p.points, p.started_at, p.finished_at
     FROM plays p JOIN users u ON u.id = p.user_id
     WHERE p.mode = ?1 AND p.day = ?2 AND p.${scope} = ?3
     ORDER BY p.done DESC, p.points DESC, p.guesses ASC, (COALESCE(p.finished_at, 0) - p.started_at) ASC
     LIMIT 50`
  ).bind(mode, day, id).all();
  return json({ rows: results, now: Date.now() });
}

// ---------- season and all-time ----------
async function board(url, env) {
  const mode = url.searchParams.get("mode");
  const scope = url.searchParams.get("scope") === "server" ? "guild_id" : "channel_id";
  const id = str(url.searchParams.get("id"));
  const period = url.searchParams.get("period") === "all" ? "all" : "season";
  if (!MODES.has(mode) || !id) return json({ error: "bad query" }, 400);
  // A season is one calendar month.
  const season = new Date().toISOString().slice(0, 7);
  const where = period === "season" ? "AND substr(p.day, 1, 7) = ?3" : "";
  const stmt = env.DB.prepare(
    `SELECT u.id, u.name, u.avatar,
            SUM(p.points) AS points,
            SUM(p.done) AS wins,
            ROUND(AVG(CASE WHEN p.done = 1 THEN p.guesses END), 2) AS avg_guesses,
            MIN(CASE WHEN p.done = 1 THEN p.guesses END) AS best
     FROM plays p JOIN users u ON u.id = p.user_id
     WHERE p.mode = ?1 AND p.${scope} = ?2 ${where}
     GROUP BY u.id
     HAVING wins > 0
     ORDER BY points DESC, wins DESC, avg_guesses ASC
     LIMIT 50`
  );
  const { results } = await (period === "season" ? stmt.bind(mode, id, season) : stmt.bind(mode, id)).all();
  return json({ rows: results, season });
}

// ---------- daily recap and streak ----------
// Who played each of the last 7 days and what they got, plus how many days in a row
// someone in this channel/server finished at least one puzzle.
async function recap(url, env) {
  const scope = url.searchParams.get("scope") === "server" ? "guild_id" : "channel_id";
  const id = str(url.searchParams.get("id")), today = url.searchParams.get("day");
  if (!id || !DAY_RE.test(today || "")) return json({ error: "bad query" }, 400);
  const since = addDays(today, -6);
  const { results } = await env.DB.prepare(
    `SELECT p.day, p.mode, p.guesses, p.done, p.points, u.id, u.name, u.avatar
     FROM plays p JOIN users u ON u.id = p.user_id
     WHERE p.${scope} = ?1 AND p.day >= ?2 AND p.day <= ?3
     ORDER BY p.day DESC, u.name`
  ).bind(id, since, today).all();
  const { results: dayRows } = await env.DB.prepare(
    `SELECT DISTINCT day FROM plays WHERE ${scope} = ?1 AND done = 1 AND day <= ?2 ORDER BY day DESC LIMIT 400`
  ).bind(id, today).all();
  // The streak counts back from today, or from yesterday if nobody has finished today yet.
  const days = new Set(dayRows.map(r => r.day));
  let d = days.has(today) ? today : addDays(today, -1), streak = 0;
  while (days.has(d)) { streak++; d = addDays(d, -1); }
  let best = 0, run = 0, prev = null;
  for (const day of [...days].sort()) { run = prev && addDays(prev, 1) === day ? run + 1 : 1; best = Math.max(best, run); prev = day; }
  return json({ rows: results, streak, best, today: days.has(today) });
}
function addDays(day, n) {
  const t = new Date(day + "T12:00:00Z"); t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

// ---------- helpers ----------
function cors() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors() } });
}
const str = v => (typeof v === "string" && /^\d{5,25}$/.test(v) ? v : null);
const clampInt = (v, lo, hi) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0; };
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function hmac(env, data) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.SESSION_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
}
async function sign(env, payload) {
  const body = b64u(new TextEncoder().encode(JSON.stringify(payload)));
  return body + "." + (await hmac(env, body));
}
async function auth(req, env) {
  const h = req.headers.get("Authorization") || "";
  const [body, sig] = h.replace(/^Bearer /, "").split(".");
  if (!body || !sig || (await hmac(env, body)) !== sig) return null;
  try {
    const p = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    return p.exp > Date.now() ? p.uid : null;
  } catch (_) { return null; }
}
