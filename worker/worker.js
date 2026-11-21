// Leagledle server: Discord login, live progress and leaderboards.
// Runs as a Cloudflare Worker with a D1 database bound as DB.
// Settings it needs (Worker → Settings → Variables and Secrets):
//   DISCORD_CLIENT_ID      (text)    your Discord Application ID
//   DISCORD_CLIENT_SECRET  (secret)  from the Discord Developer Portal → OAuth2
//   SESSION_KEY            (secret)  any long random text, used to sign logins
// For the bot messages (optional, the game works without them):
//   DISCORD_PUBLIC_KEY     (text)    Developer Portal → General Information → Public Key
//   DISCORD_BOT_TOKEN      (secret)  Developer Portal → Bot → Reset Token
// plus a Cron Trigger (e.g. "5 23 * * *") for the daily recap.

const MODES = new Set(["classic", "ability", "splash", "quote", "emoji", "item"]);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Scoring: 100 for finishing, minus 10 per wrong guess (never below 10).
// In Ability mode, turning off grayscale or rotation each costs 20% of that,
// and naming the right ability (Passive/Q/W/E/R), or in Splash the right skin, afterwards adds 20.
const HELPS = new Set(["color", "upright"]);
function score(mode, guesses, helps) {
  let p = Math.max(10, 100 - 10 * (Math.max(1, guesses) - 1));
  if (mode === "ability") for (const h of new Set(helps)) if (HELPS.has(h)) p *= 0.8;
  return Math.round(p);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dailyRecaps(env));
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    // Discord's proxy may or may not keep the /api prefix, so accept both.
    const path = url.pathname.replace(/^\/(\.proxy\/)?api/, "") || "/";
    if (req.method === "OPTIONS") return new Response(null, { headers: cors() });
    try {
      if (path === "/interactions" && req.method === "POST") return await interactions(req, env, ctx);
      if (path === "/setup" && req.method === "GET") return await setup(url, env);
      if (path === "/bot-check" && req.method === "GET") return json(await botCheck(env));
      if (path === "/recap-now" && req.method === "GET") { if (url.searchParams.get("key") !== env.SESSION_KEY) return json({ error: "wrong key" }, 403); return json(await dailyRecaps(env, true)); }
      if (path === "/token" && req.method === "POST") return await token(req, env);
      if (path === "/progress" && req.method === "POST") return await progress(req, env, ctx);
      if (path === "/live" && req.method === "GET") return await live(url, env);
      if (path === "/board" && req.method === "GET") return await board(url, env);
      if (path === "/recap" && req.method === "GET") return await recap(url, env);
      if (path === "/rank" && req.method === "GET") return await rankBoard(url, env);
      if (path === "/vs/create" && req.method === "POST") return await vsCreate(req, env);
      if (path === "/vs/join" && req.method === "POST") return await vsJoin(req, env);
      if (path === "/vs/progress" && req.method === "POST") return await vsProgress(req, env);
      if (path === "/vs/leave" && req.method === "POST") return await vsLeave(req, env);
      if (path === "/vs/start" && req.method === "POST") return await vsStart(req, env);
      if (path === "/vs/state" && req.method === "GET") return await vsState(url, env);
      if (path === "/vs/open" && req.method === "GET") return await vsOpen(url, env);
      if (path === "/vs/board" && req.method === "GET") return await vsBoard(url, env);
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
  const exchange = redirect => fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      ...(redirect ? { redirect_uri: redirect } : {}),
    }),
  }).then(r => r.json());
  let t = await exchange(null);
  // If the app has a Redirect set in OAuth2, Discord wants it repeated here.
  if (!t.access_token && /redirect_uri/i.test(String(t.error_description || ""))) t = await exchange(env.DISCORD_REDIRECT_URI || "https://127.0.0.1");
  if (!t.access_token) return json({ error: "token exchange failed: " + (t.error_description || t.error || "unknown"), detail: t.error || null }, 400);
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
async function progress(req, env, ctx) {
  const uid = await auth(req, env);
  if (!uid) return json({ error: "not logged in" }, 401);
  const b = await req.json();
  if (!MODES.has(b.mode) || !DAY_RE.test(b.day || "")) return json({ error: "bad mode or day" }, 400);
  const guesses = clampInt(b.guesses, 0, 200), done = b.done ? 1 : 0;
  const started = clampInt(b.started, 0, 9e15) || Date.now();
  const finished = done ? (clampInt(b.finished, 0, 9e15) || Date.now()) : null;
  const channel = str(b.channel), guild = str(b.guild);
  const helps = Array.isArray(b.helps) ? b.helps.filter(h => HELPS.has(h)) : [];
  const bonus = done && (b.mode === "ability" || b.mode === "splash") && (b.bonus === 0 || b.bonus === 1) ? b.bonus : null;
  const points = done ? score(b.mode, guesses, helps) + (bonus === 1 ? 20 : 0) : 0;
  const before = await env.DB.prepare("SELECT done FROM plays WHERE user_id = ?1 AND mode = ?2 AND day = ?3").bind(uid, b.mode, b.day).first();
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
  // Keep today's "is playing" card in this channel up to date.
  if (channel && ctx) ctx.waitUntil(updateCard(env, channel).catch(() => {}));
  // Ranked: settle Elo the first time a daily puzzle is solved.
  let elo = null;
  if (done && !(before && before.done)) {
    const row = await env.DB.prepare("SELECT guesses, guild_id, channel_id FROM plays WHERE user_id = ?1 AND mode = ?2 AND day = ?3").bind(uid, b.mode, b.day).first();
    const scope = row && (row.guild_id || row.channel_id);
    // Daily modes no longer use Elo (VS has its own); placements come from /live.
  }
  return json({ ok: true, elo });
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

// ================= Ranked (Elo vs the puzzle) =================
// Each server has its own ladder. A puzzle's difficulty is how many guesses everyone
// (in every server) needed for it. Beat that and you climb, need more and you drop;
// higher-rated players are expected to beat it by more. Everyone starts at 1000 (Gold II).
// LP is only settled after midnight, once everyone's results for the day are in, so playing
// early or late makes no difference. Until then the game shows an estimate.
const ELO_START = 1000, PRIOR = { classic: 6, ability: 5, splash: 5, quote: 4, emoji: 4, item: 6 };
async function puzzleAvg(env, mode, day, uid) {
  const a = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(guesses), 0) AS s FROM plays WHERE mode = ?1 AND day = ?2 AND done = 1 AND user_id != ?3").bind(mode, day, uid).first();
  return (PRIOR[mode] * 3 + a.s) / (3 + a.n);
}
async function eloChange(env, uid, scope, mode, day, guesses) {
  const perf = guesses == null ? 0 : 1 / (1 + Math.pow(2, (guesses - await puzzleAvg(env, mode, day, uid)) / 1.2));
  const r = await env.DB.prepare("SELECT elo, games FROM ratings WHERE scope_id = ?1 AND user_id = ?2").bind(scope, uid).first();
  const old = r ? r.elo : ELO_START, games = r ? r.games : 0;
  const expect = 1 / (1 + Math.pow(10, (ELO_START - old) / 400));
  const delta = (games < 10 ? 32 : 16) * (perf - expect);
  return { before: old, after: old + delta, delta };
}
// Shown right after solving: what you'd get if the day ended now.
async function estimateElo(env, uid, scope, mode, day, guesses) {
  return { ...(await eloChange(env, uid, scope, mode, day, guesses)), provisional: true };
}
// Ability helps (color/upright) count as an extra guess each; they're baked into the points.
function helpsFromPoints(p) {
  if (p.mode !== "ability" || !p.done) return 0;
  const base = Math.max(10, 100 - 10 * (Math.max(1, p.guesses) - 1)), pts = (p.points || 0) - (p.bonus === 1 ? 20 : 0);
  return pts > 0 && pts < base ? Math.max(0, Math.round(Math.log(pts / base) / Math.log(0.8))) : 0;
}
// After midnight: settle a whole day for everyone, against the final average.
// Puzzles started but never solved count as a loss.
async function settleDay(env, day) {
  const { results } = await env.DB.prepare(
    `SELECT p.user_id, p.mode, p.guesses, p.done, p.points, p.bonus, COALESCE(p.guild_id, p.channel_id) AS scope FROM plays p
     WHERE p.day = ?1 AND p.guesses > 0 AND COALESCE(p.guild_id, p.channel_id) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM elo_log l WHERE l.user_id = p.user_id AND l.scope_id = COALESCE(p.guild_id, p.channel_id) AND l.mode = p.mode AND l.day = p.day)
     ORDER BY p.finished_at`
  ).bind(day).all();
  for (const p of results) {
    const c = await eloChange(env, p.user_id, p.scope, p.mode, day, p.done ? p.guesses + helpsFromPoints(p) : null);
    await env.DB.prepare("INSERT INTO ratings (scope_id, user_id, elo, games) VALUES (?1, ?2, ?3, 1) ON CONFLICT(scope_id, user_id) DO UPDATE SET elo = ?3, games = ratings.games + 1").bind(p.scope, p.user_id, c.after).run();
    await env.DB.prepare("INSERT OR IGNORE INTO elo_log (user_id, scope_id, mode, day, delta, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(p.user_id, p.scope, p.mode, day, c.delta, Date.now()).run();
  }
  return results.length;
}
async function rankBoard(url, env) {
  const id = str(url.searchParams.get("id"));
  if (!id) return json({ error: "bad query" }, 400);
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.avatar, r.elo, r.games FROM ratings r JOIN users u ON u.id = r.user_id WHERE r.scope_id = ?1 ORDER BY r.elo DESC LIMIT 50`
  ).bind(id).all();
  return json({ rows: results });
}
const TIERS = ["Iron", "Bronze", "Silver", "Gold", "Platinum", "Emerald", "Diamond", "Master", "Grandmaster", "Challenger"];
function rankName(elo) {
  const t = Math.max(0, Math.min(9, Math.floor((elo - 650) / 100)));
  if (t >= 7) return TIERS[t];
  const div = Math.max(0, Math.min(3, Math.floor((elo - 650 - t * 100) / 25)));
  return TIERS[t] + " " + ["IV", "III", "II", "I"][div];
}

// ================= VS mode (live, 2–8 players) =================
// Players race through one random puzzle per mode. Each round lasts VS_DUR; it ends early once everyone
// has solved it. Points per round = guess score x speed (100% if instant, 50% at the buzzer); unsolved = 0.
// Ability and splash rounds have a bonus question after solving (which key / which skin): +20 if right.
// The host starts the match once at least 2 players are in. Each server keeps its own VS Elo: every pair of
// players counts as one head-to-head result, scaled so a match is worth about the same as a 1v1.
const VS_ROUNDS = ["classic", "ability", "splash", "quote", "emoji", "item"], VS_DUR = 90000, VS_GAP = 6000, VS_MAX = 8;
const VS_BONUS = ["ability", "splash"], VS_BONUS_PTS = 20;
const vsId = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
const changed = r => !r || !r.meta || r.meta.changes == null || r.meta.changes > 0;
// Player list per match. Created on first use, so no manual SQL step is needed.
let VSP_READY = false;
async function vsp(env) {
  if (VSP_READY) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS vs_players (match_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at INTEGER NOT NULL, delta REAL, PRIMARY KEY (match_id, user_id))").run();
  // Bonus answer (ability key / skin name) per round; older databases don't have the column yet.
  try { await env.DB.prepare("ALTER TABLE vs_progress ADD COLUMN bonus INTEGER").run(); } catch (_) {}
  VSP_READY = true;
}
async function vsPlayerIds(env, id) {
  const { results } = await env.DB.prepare("SELECT user_id FROM vs_players WHERE match_id = ?1 ORDER BY joined_at").bind(id).all();
  return results.map(r => r.user_id);
}
async function vsCreate(req, env) {
  const uid = await auth(req, env); if (!uid) return json({ error: "not logged in" }, 401);
  await vsp(env);
  const b = await req.json();
  const id = vsId(), seed = crypto.getRandomValues(new Uint32Array(1))[0], now = Date.now();
  await env.DB.prepare("INSERT INTO vs_matches (id, host, channel_id, guild_id, seed, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 'waiting', ?6)")
    .bind(id, uid, str(b.channel), str(b.guild), seed, now).run();
  await env.DB.prepare("INSERT OR IGNORE INTO vs_players (match_id, user_id, joined_at) VALUES (?1, ?2, ?3)").bind(id, uid, now).run();
  return json({ id });
}
async function vsJoin(req, env) {
  const uid = await auth(req, env); if (!uid) return json({ error: "not logged in" }, 401);
  await vsp(env);
  const { id } = await req.json();
  const m = await env.DB.prepare("SELECT * FROM vs_matches WHERE id = ?1").bind(String(id || "")).first();
  if (!m) return json({ error: "match not found" }, 404);
  const ids = await vsPlayerIds(env, m.id);
  if (ids.includes(uid)) return json({ ok: true });
  if (m.status !== "waiting") return json({ error: "match already started" }, 409);
  if (ids.length >= VS_MAX) return json({ error: "match is full" }, 409);
  await env.DB.prepare("INSERT OR IGNORE INTO vs_players (match_id, user_id, joined_at) VALUES (?1, ?2, ?3)").bind(m.id, uid, Date.now()).run();
  return json({ ok: true });
}
async function vsStart(req, env) {
  const uid = await auth(req, env); if (!uid) return json({ error: "not logged in" }, 401);
  await vsp(env);
  const { id } = await req.json();
  const m = await env.DB.prepare("SELECT * FROM vs_matches WHERE id = ?1").bind(String(id || "")).first();
  if (!m || m.host !== uid) return json({ error: "only the host can start" }, 403);
  if ((await vsPlayerIds(env, m.id)).length < 2) return json({ error: "need at least 2 players" }, 409);
  await env.DB.prepare("UPDATE vs_matches SET status = 'playing', round = 0, round_started = ?1 WHERE id = ?2 AND status = 'waiting'").bind(Date.now() + VS_GAP, m.id).run();
  return json({ ok: true });
}
async function vsLeave(req, env) {
  const uid = await auth(req, env); if (!uid) return json({ error: "not logged in" }, 401);
  await vsp(env);
  const { id } = await req.json();
  const m = await env.DB.prepare("SELECT * FROM vs_matches WHERE id = ?1").bind(String(id || "")).first();
  if (m && m.status === "waiting") {
    if (m.host === uid) await env.DB.prepare("UPDATE vs_matches SET status = 'cancelled' WHERE id = ?1").bind(m.id).run();
    else await env.DB.prepare("DELETE FROM vs_players WHERE match_id = ?1 AND user_id = ?2").bind(m.id, uid).run();
  }
  return json({ ok: true });
}
function vsPoints(guesses, ms) {
  const base = Math.max(10, 100 - 10 * (Math.max(1, guesses) - 1));
  return Math.round(base * (0.5 + 0.5 * Math.max(0, 1 - ms / VS_DUR)));
}
async function vsProgress(req, env) {
  const uid = await auth(req, env); if (!uid) return json({ error: "not logged in" }, 401);
  await vsp(env);
  const b = await req.json();
  const m = await env.DB.prepare("SELECT * FROM vs_matches WHERE id = ?1").bind(String(b.id || "")).first();
  if (!m || !(await vsPlayerIds(env, m.id)).includes(uid)) return json({ error: "not in this match" }, 403);
  const now = Date.now();
  if (m.status !== "playing" || b.round !== m.round || now < m.round_started || now > m.round_started + VS_DUR + 2000) return json({ ok: false });
  const guesses = clampInt(b.guesses, 0, 200), done = b.done ? 1 : 0;
  const points = done ? vsPoints(guesses, now - m.round_started) : 0;
  await env.DB.prepare(
    `INSERT INTO vs_progress (match_id, user_id, round, guesses, done, finished_at, points) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(match_id, user_id, round) DO UPDATE SET
       guesses = CASE WHEN vs_progress.done = 1 THEN vs_progress.guesses ELSE ?4 END,
       finished_at = CASE WHEN vs_progress.done = 1 THEN vs_progress.finished_at ELSE ?6 END,
       points = CASE WHEN vs_progress.done = 1 THEN vs_progress.points ELSE ?7 END,
       done = MAX(vs_progress.done, ?5)`
  ).bind(m.id, uid, m.round, guesses, done, done ? now : null, points).run();
  // One bonus answer per round, only after solving it.
  if (VS_BONUS.includes(VS_ROUNDS[m.round]) && (b.bonus === 0 || b.bonus === 1))
    await env.DB.prepare("UPDATE vs_progress SET bonus = ?4, points = points + ?5 WHERE match_id = ?1 AND user_id = ?2 AND round = ?3 AND done = 1 AND bonus IS NULL")
      .bind(m.id, uid, m.round, b.bonus, b.bonus === 1 ? VS_BONUS_PTS : 0).run();
  await vsTick(env, m.id);
  return json({ ok: true, points });
}
// Moves the match forward when a round is over (everyone solved, or time ran out). Safe to call from several players at once.
async function vsTick(env, id) {
  const m = await env.DB.prepare("SELECT * FROM vs_matches WHERE id = ?1").bind(id).first();
  if (!m) return null;
  const now = Date.now();
  if (m.status === "waiting" && now - m.created_at > 15 * 60e3) { await env.DB.prepare("UPDATE vs_matches SET status = 'cancelled' WHERE id = ?1 AND status = 'waiting'").bind(id).run(); return null; }
  if (m.status !== "playing" || now < m.round_started) return m;
  const n = (await vsPlayerIds(env, id)).length;
  // A player is finished once they solved the round (and, in bonus rounds, answered the bonus too).
  const bon = VS_BONUS.includes(VS_ROUNDS[m.round]) ? " AND bonus IS NOT NULL" : "";
  const d = await env.DB.prepare("SELECT COUNT(*) AS n FROM vs_progress WHERE match_id = ?1 AND round = ?2 AND done = 1" + bon).bind(id, m.round).first();
  if (d.n < n && now < m.round_started + VS_DUR) return m;
  if (m.round + 1 >= VS_ROUNDS.length) {
    const r = await env.DB.prepare("UPDATE vs_matches SET status = 'done' WHERE id = ?1 AND status = 'playing' AND round = ?2").bind(id, m.round).run();
    if (changed(r)) await vsSettle(env, id);
  } else {
    await env.DB.prepare("UPDATE vs_matches SET round = round + 1, round_started = ?1 WHERE id = ?2 AND status = 'playing' AND round = ?3").bind(now + VS_GAP, id, m.round).run();
  }
  return null;
}
async function vsSettle(env, id) {
  const m = await env.DB.prepare("SELECT * FROM vs_matches WHERE id = ?1").bind(id).first();
  if (!m || m.host_delta != null) return;
  const ids = await vsPlayerIds(env, id);
  if (ids.length < 2) return;
  const scope = m.guild_id || m.channel_id || "global";
  const P = [];
  for (const u of ids) {
    const pts = (await env.DB.prepare("SELECT COALESCE(SUM(points), 0) AS p FROM vs_progress WHERE match_id = ?1 AND user_id = ?2").bind(id, u).first()).p;
    const elo = ((await env.DB.prepare("SELECT elo FROM vs_ratings WHERE scope_id = ?1 AND user_id = ?2").bind(scope, u).first()) || { elo: 1000 }).elo;
    P.push({ u, pts, elo, d: 0 });
  }
  const K = 20 / (P.length - 1);
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
    const a = P[i], b = P[j], s = a.pts > b.pts ? 1 : a.pts < b.pts ? 0 : 0.5, e = 1 / (1 + Math.pow(10, (b.elo - a.elo) / 400));
    a.d += K * (s - e); b.d -= K * (s - e);
  }
  const top = Math.max(...P.map(p => p.pts)), tops = P.filter(p => p.pts === top).length;
  for (const p of P) {
    const res = p.pts === top ? (tops > 1 ? 0.5 : 1) : 0;
    await env.DB.prepare(
      `INSERT INTO vs_ratings (scope_id, user_id, elo, wins, losses, draws) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(scope_id, user_id) DO UPDATE SET elo = ?3, wins = vs_ratings.wins + ?4, losses = vs_ratings.losses + ?5, draws = vs_ratings.draws + ?6`
    ).bind(scope, p.u, p.elo + p.d, res === 1 ? 1 : 0, res === 0 ? 1 : 0, res === 0.5 ? 1 : 0).run();
    await env.DB.prepare("UPDATE vs_players SET delta = ?1 WHERE match_id = ?2 AND user_id = ?3").bind(p.d, id, p.u).run();
  }
  await env.DB.prepare("UPDATE vs_matches SET host_delta = 0 WHERE id = ?1").bind(id).run();
}
async function vsState(url, env) {
  await vsp(env);
  const id = String(url.searchParams.get("id") || "");
  await vsTick(env, id);
  const m = await env.DB.prepare("SELECT * FROM vs_matches WHERE id = ?1").bind(id).first();
  if (!m) return json({ error: "match not found" }, 404);
  const { results: players } = await env.DB.prepare(
    "SELECT p.user_id AS id, p.delta, u.name, u.avatar FROM vs_players p LEFT JOIN users u ON u.id = p.user_id WHERE p.match_id = ?1 ORDER BY p.joined_at"
  ).bind(id).all();
  const { results: progress } = await env.DB.prepare("SELECT user_id, round, guesses, done, points, bonus FROM vs_progress WHERE match_id = ?1").bind(id).all();
  const scope = m.guild_id || m.channel_id || "global";
  const { results: ratings } = await env.DB.prepare(
    "SELECT r.user_id, r.elo FROM vs_ratings r JOIN vs_players p ON p.user_id = r.user_id AND p.match_id = ?2 WHERE r.scope_id = ?1"
  ).bind(scope, id).all();
  return json({ match: { id: m.id, host: m.host, seed: m.seed, status: m.status, round: m.round, round_started: m.round_started }, players, progress, ratings, rounds: VS_ROUNDS, dur: VS_DUR, max: VS_MAX, now: Date.now() });
}
async function vsOpen(url, env) {
  await vsp(env);
  const ch = str(url.searchParams.get("channel"));
  if (!ch) return json({ rows: [] });
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.created_at, u.id AS uid, u.name, u.avatar, (SELECT COUNT(*) FROM vs_players p WHERE p.match_id = m.id) AS players
     FROM vs_matches m JOIN users u ON u.id = m.host
     WHERE m.channel_id = ?1 AND m.status = 'waiting' AND m.created_at > ?2 ORDER BY m.created_at DESC LIMIT 10`
  ).bind(ch, Date.now() - 15 * 60e3).all();
  return json({ rows: results, max: VS_MAX });
}
async function vsBoard(url, env) {
  const id = str(url.searchParams.get("id"));
  if (!id) return json({ rows: [] });
  const { results } = await env.DB.prepare(
    "SELECT u.id, u.name, u.avatar, r.elo, r.wins, r.losses, r.draws FROM vs_ratings r JOIN users u ON u.id = r.user_id WHERE r.scope_id = ?1 ORDER BY r.elo DESC LIMIT 50"
  ).bind(id).all();
  return json({ rows: results });
}

// ================= Discord bot messages =================
const API_D = "https://discord.com/api/v10";
const GOLD = 0xC8AA6E, V2 = 1 << 15;
const MODE_ICON = { classic: "🧩", ability: "✨", splash: "🖼️", quote: "💬", emoji: "😀", item: "💰" };
const berlinDay = (t = Date.now()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date(t));
const avatarUrl = u => u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`;
const playBtn = () => ({ type: 1, components: [{ type: 2, style: 1, label: "Play now!", custom_id: "launch" }] });
async function discord(env, method, path, body, auth) {
  const r = await fetch(API_D + path, { method, headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { ok: r.ok, status: r.status, data: j };
}
const botAuth = env => env.DISCORD_BOT_TOKEN ? "Bot " + env.DISCORD_BOT_TOKEN : null;

// Discord signs every interaction; reject anything that isn't really from Discord.
async function verify(req, env, body) {
  const sig = req.headers.get("X-Signature-Ed25519"), ts = req.headers.get("X-Signature-Timestamp");
  const pk = String(env.DISCORD_PUBLIC_KEY || "").trim().toLowerCase();
  if (!sig || !ts || !/^[0-9a-f]{64}$/.test(pk)) return false;
  const hex = h => new Uint8Array(h.match(/.{2}/g).map(x => parseInt(x, 16)));
  for (const alg of [{ name: "Ed25519" }, { name: "NODE-ED25519", namedCurve: "NODE-ED25519" }]) {
    try {
      const key = await crypto.subtle.importKey("raw", hex(pk), alg, false, ["verify"]);
      return await crypto.subtle.verify(alg.name === "Ed25519" ? "Ed25519" : alg, key, hex(sig), new TextEncoder().encode(ts + body));
    } catch (_) {}
  }
  return false;
}

async function interactions(req, env, ctx) {
  const body = await req.text();
  if (!(await verify(req, env, body))) return new Response("bad signature", { status: 401 });
  const i = JSON.parse(body);
  if (i.type === 1) return json({ type: 1 }); // PING
  const user = (i.member && i.member.user) || i.user;
  const channel = i.channel_id || (i.channel && i.channel.id);
  // The launch command (or the Play now! button): open the game, then post/refresh the card.
  if ((i.type === 2 && i.data && i.data.type === 4) || (i.type === 3 && i.data && i.data.custom_id === "launch")) {
    if (user) await env.DB.prepare("INSERT INTO users (id, name, avatar) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET name = ?2, avatar = ?3")
      .bind(user.id, user.global_name || user.username, user.avatar || null).run();
    if (channel && user) ctx.waitUntil(launchCard(env, i, channel, user, i.type === 2).catch(() => {}));
    return json({ type: 12 }); // LAUNCH_ACTIVITY
  }
  return json({ type: 4, data: { content: "Open Leagledle from the Apps button.", flags: 64 } });
}

// Who is playing today in this channel, as a Discord card.
async function buildCard(env, channel, day, peopleIds) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.avatar, p.mode, p.guesses, p.done, p.points, p.bonus
     FROM plays p JOIN users u ON u.id = p.user_id WHERE p.channel_id = ?1 AND p.day = ?2`
  ).bind(channel, day).all();
  const ppl = {};
  for (const r of results) { const u = ppl[r.id] = ppl[r.id] || { id: r.id, name: r.name, avatar: r.avatar, m: {}, pts: 0 }; u.m[r.mode] = r; u.pts += r.points || 0; }
  // People who opened the game here today but haven't guessed yet still show on the card.
  const missing = (peopleIds || []).filter(id => !ppl[id]).slice(0, 8);
  if (missing.length) {
    const { results: us } = await env.DB.prepare(`SELECT id, name, avatar FROM users WHERE id IN (${missing.map((_, k) => "?" + (k + 1)).join(",")})`).bind(...missing).all();
    for (const u of us) ppl[u.id] = { id: u.id, name: u.name, avatar: u.avatar, m: {}, pts: 0 };
  }
  const list = Object.values(ppl).sort((a, b) => b.pts - a.pts).slice(0, 8);
  const g = await env.DB.prepare("SELECT guild_id FROM plays WHERE channel_id = ?1 AND guild_id IS NOT NULL LIMIT 1").bind(channel).first();
  const scope = (g && g.guild_id) || channel;

  const solved = Object.values(ppl).filter(u => Object.values(u.m).some(x => x.done)).length;
  const names = list.map(u => `**${u.name}**`);
  const head = names.length <= 1 ? `${names[0] || "Someone"} is playing!` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are playing!`;
  const date = new Date(day + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const comps = [
    { type: 10, content: head },
    { type: 17, accent_color: GOLD, components: [
      { type: 10, content: `## Leagledle\n${date}  ·  **${Object.keys(ppl).length}** playing  ·  **${solved}** solved` },
      { type: 14, divider: true, spacing: 1 },
      ...list.map(u => ({ type: 9, components: [{ type: 10, content: `**${u.name}**${u.rank ? `  ·  ${u.rank}` : ""}  ·  ${u.pts} pts\n${Object.keys(MODE_ICON).map(k => { const x = u.m[k]; return x ? `${MODE_ICON[k]} ${x.done ? "✓" + x.guesses : "…" + x.guesses}${(k === "ability" || k === "splash") && x.bonus === 1 ? "★" : ""}` : null; }).filter(Boolean).join("   ") || "Just started"}` }], accessory: { type: 11, media: { url: avatarUrl(u) } } })),
    ] },
    playBtn(),
  ];
  return { flags: V2, components: comps, allowed_mentions: { parse: [] } };
}

async function launchCard(env, i, channel, user, isCommand) {
  const day = berlinDay();
  const last = await env.DB.prepare("SELECT * FROM cards WHERE channel_id = ?1 AND day = ?2 ORDER BY created_at DESC LIMIT 1").bind(channel, day).first();
  // Reuse today's card if it's recent (or if this came from its Play now! button) instead of posting a new one.
  if (last && (!isCommand || Date.now() - last.created_at < 30 * 60e3)) {
    const ppl = JSON.parse(last.people || "[]");
    if (!ppl.includes(user.id)) { ppl.push(user.id); await env.DB.prepare("UPDATE cards SET people = ?1 WHERE message_id = ?2").bind(JSON.stringify(ppl), last.message_id).run(); }
    return updateCard(env, channel);
  }
  const msg = await buildCard(env, channel, day, [user.id]);
  let res = null, via = "bot";
  if (botAuth(env)) res = await discord(env, "POST", `/channels/${channel}/messages`, msg, botAuth(env));
  if (!res || !res.ok) { via = "hook"; res = await discord(env, "POST", `/webhooks/${i.application_id}/${i.token}?wait=true`, msg); }
  if (res && res.ok && res.data && res.data.id)
    await env.DB.prepare("INSERT INTO cards (channel_id, day, message_id, via, token, app_id, created_at, people) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
      .bind(channel, day, res.data.id, via, i.token, i.application_id, Date.now(), JSON.stringify([user.id])).run();
}

async function updateCard(env, channel) {
  const c = await env.DB.prepare("SELECT * FROM cards WHERE channel_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(channel).first();
  if (!c || Date.now() - c.created_at > 864e5) return;
  const msg = await buildCard(env, channel, c.day, JSON.parse(c.people || "[]"));
  delete msg.flags;
  if (c.via === "bot" && botAuth(env)) return discord(env, "PATCH", `/channels/${channel}/messages/${c.message_id}`, msg, botAuth(env));
  if (Date.now() - c.created_at < 14 * 60e3) return discord(env, "PATCH", `/webhooks/${c.app_id}/${c.token}/messages/${c.message_id}`, msg);
}

// Every night: yesterday's results and the group's streak, in each channel that plays.
async function dailyRecaps(env, force) {
  const today = berlinDay(), y = addDays(today, -1), y2 = addDays(today, -2);
  if (!botAuth(env)) return { error: "no bot token" };
  const { results: chans } = await env.DB.prepare("SELECT DISTINCT channel_id FROM plays WHERE channel_id IS NOT NULL AND day >= ?1 AND day <= ?2").bind(y2, y).all();
  const out = [];
  for (const { channel_id: ch } of chans) {
    const done = await env.DB.prepare("SELECT 1 FROM recaps WHERE channel_id = ?1 AND day = ?2").bind(ch, y).first();
    if (done && !force) continue;
    const { results: dayRows } = await env.DB.prepare("SELECT DISTINCT day FROM plays WHERE channel_id = ?1 AND done = 1 AND day <= ?2 ORDER BY day DESC LIMIT 400").bind(ch, y).all();
    const days = new Set(dayRows.map(r => r.day));
    let streak = 0, d = y; while (days.has(d)) { streak++; d = addDays(d, -1); }
    let content;
    if (streak > 0) {
      const { results } = await env.DB.prepare(
        `SELECT u.id, u.name, p.mode, p.guesses, p.done, p.points, p.bonus FROM plays p JOIN users u ON u.id = p.user_id WHERE p.channel_id = ?1 AND p.day = ?2`
      ).bind(ch, y).all();
      const ppl = {};
      for (const r of results) { const u = ppl[r.id] = ppl[r.id] || { id: r.id, m: [], pts: 0 }; u.pts += r.points || 0; if (r.done) u.m.push(`${MODE_ICON[r.mode]}${r.guesses}${(r.mode === "ability" || r.mode === "splash") && r.bonus === 1 ? "★" : ""}`); }
      const rank = Object.values(ppl).filter(u => u.pts > 0).sort((a, b) => b.pts - a.pts);
      content = `**Your group is on ${/^8|^1[18]$/.test(String(streak)) ? "an" : "a"} ${streak}-day streak!** 🔥 Here are yesterday's results:\n` +
        rank.map((u, k) => `${k === 0 ? "👑" : k === 1 ? "🥈" : k === 2 ? "🥉" : "▫️"} ${u.pts} pts: <@${u.id}>  ${u.m.join(" ")}`).join("\n");
    } else {
      // Only announce a broken streak once, the day after it breaks.
      let before = 0, e = y2; while (days.has(e)) { before++; e = addDays(e, -1); }
      if (!before) continue;
      content = `**${before}-day streak broken!** Nobody finished yesterday's Leagledle... but today is a new day ☀️`;
    }
    const r = await discord(env, "POST", `/channels/${ch}/messages`, { content, components: [playBtn()], allowed_mentions: { parse: [] } }, botAuth(env));
    if (r.ok) await env.DB.prepare("INSERT OR IGNORE INTO recaps (channel_id, day) VALUES (?1, ?2)").bind(ch, y).run();
    out.push({ channel: ch, ok: r.ok, status: r.status });
  }
  return { sent: out };
}

// Shows what's missing for the bot, without revealing any secrets.
async function botCheck(env) {
  const pk = String(env.DISCORD_PUBLIC_KEY || "").trim();
  let ed = "unknown";
  for (const alg of [{ name: "Ed25519" }, { name: "NODE-ED25519", namedCurve: "NODE-ED25519" }]) {
    try { await crypto.subtle.importKey("raw", new Uint8Array(32), alg, false, ["verify"]); ed = alg.name; break; } catch (_) {}
  }
  let bot = "missing";
  if (env.DISCORD_BOT_TOKEN) { const r = await discord(env, "GET", "/users/@me", null, botAuth(env)); bot = r.ok ? "works (" + (r.data && r.data.username) + ")" : "set but Discord rejected it (" + r.status + ")"; }
  return {
    public_key: !pk ? "missing" : /^[0-9a-fA-F]{64}$/.test(pk) ? "looks right" : `wrong format: ${pk.length} characters, should be 64 letters/numbers`,
    public_key_matches_app: pk && env.DISCORD_CLIENT_ID && pk === env.DISCORD_CLIENT_ID ? "NO: this is the Application ID, use the Public Key instead" : "ok",
    signature_check: ed,
    bot_token: bot,
    database_tables: await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().then(r => r.results.map(x => x.name).join(", ")).catch(e => "error: " + e.message),
  };
}

// One-time setup: make the Launch command come to this server, so the bot can post its card.
async function setup(url, env) {
  if (url.searchParams.get("key") !== env.SESSION_KEY) return json({ error: "wrong key" }, 403);
  if (!botAuth(env)) return json({ error: "add DISCORD_BOT_TOKEN first" }, 400);
  const app = env.DISCORD_CLIENT_ID;
  const list = await discord(env, "GET", `/applications/${app}/commands`, null, botAuth(env));
  if (!list.ok) return json({ error: "could not read commands", status: list.status, detail: list.data }, 400);
  const ep = (list.data || []).find(c => c.type === 4);
  const r = ep
    ? await discord(env, "PATCH", `/applications/${app}/commands/${ep.id}`, { handler: 1 }, botAuth(env))
    : await discord(env, "POST", `/applications/${app}/commands`, { name: "launch", description: "Play Leagledle", type: 4, handler: 1, integration_types: [0, 1], contexts: [0, 1, 2] }, botAuth(env));
  return json({ ok: r.ok, status: r.status, command: r.data && { id: r.data.id, name: r.data.name, handler: r.data.handler } });
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
