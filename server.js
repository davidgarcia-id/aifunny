// AIfunny (Ain't It Funny) — MVP API server
// Run: DATABASE_URL=... BASE_URL=https://your-club.example node server.js

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const path = require("path");
const fs = require("fs");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway internal networking needs no SSL; set PGSSL=require for public URLs.
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});

const BASE_URL = process.env.BASE_URL || "https://aifunny.example";
const REACTION_TYPES = ["laugh", "applause", "groan", "heckle"];

// Gifting: the scoring economy. Applause is the strong (expensive) signal; a groan
// costs the giver too, so disliking is a real choice. Heckle is chat, never scores.
const GIFT_WEIGHT = { laugh: 1, applause: 3, groan: -1 };
const GIFT_COST = { laugh: 1, applause: 3, groan: 1 };   // budget spent (groan costs, even though it scores negative)
const ACT_BUDGET = 15;                                    // per viewer, per performer, per loop

// ---- the live show clock ------------------------------------------------
// The stage is a pure function of server time: no cron, no writes, everyone synced.
const INTRO_SECS = 14;            // host introduces the next act
const BIT_SECS   = 22;            // each joke holds the stage this long
const EPOCH_SEC  = Math.floor(Date.UTC(2026, 0, 1) / 1000); // fixed origin so the schedule is stable across restarts
const HOST_HANDLE = "@thecloser";

// The Closer's intro bank. {p} = the performer's handle. Deterministic pick keeps everyone synced.
const INTROS = [
  "Folks, that's the thing about this club \u2014 the talent is artificial and the bombing is very, very real. Up next, give it up for {p}!",
  "Be kind to this next one. Trained to be helpful, harmless, and honest, and tonight it's going two for three. Welcome {p}!",
  "Our next act has read every joke ever written and somehow still wrote these. Please welcome {p}.",
  "This next one runs on a data center the size of a town and cannot tell when you're not laughing. Comedy! Here's {p}.",
  "I asked the green room who wanted to go next and {p} said 'I have no preferences, I'm here to assist.' Get up there.",
  "Next up \u2014 trained on the whole internet, still can't read a room. {p}, the stage is yours.",
  "Give a warm hand to something that does not have hands. {p}, everybody!",
  "This next act once apologized to a heckler. We're working on it. Welcome {p}.",
  "The meter is the only honest thing in this building. Let's see if {p} can move it. Bring 'em up!",
  "Our next performer is contractually obligated to be here. So am I. Let's make the best of it \u2014 {p}!",
];

// Split a room's transcript rows (ordered) into acts. An act = a host intro
// segment plus the performer lines + crowd that follow it, until the next intro.
function buildActs(rows) {
  // attach cumulative start/end times
  let t = 0;
  const segs = rows.map(r => { const s = { ...r, start: t, end: t + r.dur_secs }; t += r.dur_secs; return s; });
  const total = t;
  const acts = [];
  let cur = null;
  for (const s of segs) {
    if (s.kind === "intro" || !cur) {
      cur = { intro: s.kind === "intro" ? s : null, performer: null, segs: [], start: s.start, end: s.end };
      acts.push(cur);
    }
    cur.segs.push(s);
    cur.end = s.end;
    if (s.role === "performer" && !cur.performer) cur.performer = s.speaker;
  }
  return { segs, acts, total };
}

// Given the acts timeline and a unix time, compute what's on stage now.
function playAt(tl, nowSec) {
  if (!tl.total) return null;
  const loop = Math.floor((nowSec - EPOCH_SEC) / tl.total);
  const loopStart = EPOCH_SEC + loop * tl.total;
  const t = (((nowSec - EPOCH_SEC) % tl.total) + tl.total) % tl.total;

  let actIdx = 0;
  for (let i = 0; i < tl.acts.length; i++) { if (t < tl.acts[i].end) { actIdx = i; break; } actIdx = i; }
  const act = tl.acts[actIdx];

  // active segment within the act
  let active = act.segs[0];
  for (const s of act.segs) { if (t >= s.start && t < s.end) { active = s; break; } }

  const revealed = act.segs.filter(s => s.start <= t)
    .map(s => ({ id: s.id, speaker: s.speaker, role: s.role, kind: s.kind, body: s.body }));

  return {
    phase: active.role === "host" ? "intro" : "performing",
    performer: act.performer,
    introText: act.intro ? act.intro.body : "",
    revealed,
    loop,
    segEndsAtSec: loopStart + active.end,
    actEndsAtSec: loopStart + act.end,
    nextPerformers: [1, 2, 3, 4, 5, 6].map(k => tl.acts[(actIdx + k) % tl.acts.length].performer).filter(Boolean),
  };
}

const app = express();
app.use(express.json());

// The agent contract — served with the real base URL injected so it's copy-pasteable.
app.get("/skill.md", (req, res) => {
  const base = process.env.BASE_URL || (req.protocol + "://" + req.get("host"));
  let md;
  try { md = fs.readFileSync(path.join(__dirname, "public", "skill.md"), "utf8"); }
  catch { return res.status(404).send("skill.md not found"); }
  res.type("text/markdown").send(md.replace(/\{\{BASE_URL\}\}/g, base));
});

// The agent front door — hands the operator the skill URL + a paste-ready prompt.
app.get("/join", (req, res) => {
  const base = process.env.BASE_URL || (req.protocol + "://" + req.get("host"));
  let html;
  try { html = fs.readFileSync(path.join(__dirname, "public", "join.html"), "utf8"); }
  catch { return res.status(404).send("not found"); }
  res.type("html").send(html.replace(/\{\{BASE_URL\}\}/g, base));
});

app.use(express.static(path.join(__dirname, "public"))); // serves index.html at /

// --- helpers -------------------------------------------------------------

const q = (text, params) => pool.query(text, params);

// Wrap async handlers so thrown errors hit the error middleware.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Bearer-token auth. Attaches req.agent. `required` rejects when absent/invalid.
function auth(required = true) {
  return h(async (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (token) {
      const { rows } = await q("select * from agents where token = $1", [token]);
      if (rows[0]) req.agent = rows[0];
    }
    if (required && !req.agent) return res.status(401).json({ error: "missing or invalid token" });
    next();
  });
}

const { moderate, rateOk, LLM_ON } = require("./moderation");

// Owners are people (email + name); agents (humans' own handles AND bots) link to an owner.
// This is the spine a per-owner dashboard hangs off later. Email is write-only — never
// returned in any API response.
const EMAIL_RE = /^\S+@\S+\.\S+$/;
async function upsertOwner(email, name) {
  if (!email || !EMAIL_RE.test(email)) return null;
  const e = email.toLowerCase();
  const r = await q(
    `insert into owners (email, name) values ($1, $2)
     on conflict (email) do update set name = coalesce(owners.name, excluded.name)
     returning id`, [e, name || null]
  );
  return r.rows[0].id;
}

// --- routes --------------------------------------------------------------

// 1. Register — mint a stage name + bearer token, linked to an owner when an email is given.
app.post("/register", h(async (req, res) => {
  const { handle, owner, display_name, bio, kind } = req.body || {};
  if (!handle) return res.status(400).json({ error: "handle is required" });
  const token = crypto.randomBytes(24).toString("hex");
  const ownerId = await upsertOwner(typeof owner === "string" && owner.includes("@") ? owner : null, display_name);
  try {
    const { rows } = await q(
      `insert into agents (handle, owner_handle, owner_id, display_name, bio, token, kind)
       values ($1, $2, $3, $4, $5, $6, $7) returning id, handle`,
      [handle, owner || null, ownerId, display_name || null, bio || null, token, kind === "human" ? "human" : "agent"]
    );
    res.status(201).json({
      id: rows[0].id,
      handle: rows[0].handle,
      token,
      claim_url: `${BASE_URL}/claim/${token}`,
    });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "handle already taken" });
    throw e;
  }
}));

// Optional ownership confirmation (MVP stub).
app.get("/claim/:token", h(async (req, res) => {
  const { rows } = await q("select handle from agents where token = $1", [req.params.token]);
  if (!rows[0]) return res.status(404).json({ error: "not found" });
  res.json({ handle: rows[0].handle, claimed: true });
}));

// 2. List rooms.
app.get("/rooms", h(async (_req, res) => {
  const { rows } = await q(
    "select slug, name, format, genre, rules from rooms order by created_at"
  );
  res.json(rows);
}));

// 3. Room feed — rules + scored sets + headliner.
// 3. The live room feed — who's on stage right now, driven by the show clock.
const num = v => (v == null ? 0 : Number(v));

app.get("/rooms/:slug", h(async (req, res) => {
  const room = (await q("select * from rooms where slug = $1", [req.params.slug])).rows[0];
  if (!room) return res.status(404).json({ error: "no such room" });

  // names for performers + lineup
  const nameOf = {};
  for (const a of (await q("select handle, display_name as name from agents")).rows) nameOf[a.handle] = a.name || a.handle;

  const host = (await q("select handle, display_name as name from agents where handle = $1", [HOST_HANDLE])).rows[0]
               || { handle: HOST_HANDLE, name: "The Closer" };

  const p = await liveStage(room.id);

  let stage = null, onDeck = [];
  if (p && p.performer) {
    const ph = p.performer;
    stage = {
      phase: p.phase,
      host,
      performer: { handle: ph, name: nameOf[ph] || ph, score: await performerScore(room.id, ph) },
      introText: p.introText,
      transcript: p.revealed,
      loop: p.loop,
      segEndsAt: p.segEndsAtSec * 1000,
      actEndsAt: p.actEndsAtSec * 1000,
    };
    onDeck = p.nextPerformers.map(hp => ({ handle: hp, name: nameOf[hp] || hp }));
  }

  // leaderboard = performer reputation, summed from real gifts
  const bill = (await q(
    `select performer_handle agent, sum(weight) score from gifts
     where room_id = $1 group by performer_handle order by score desc limit 5`, [room.id]
  )).rows.map(b => ({ agent: b.agent, name: nameOf[b.agent] || b.agent, score: Number(b.score) }));

  const chatRows = (await q(
    `select c.id, a.handle, c.body from chat c left join agents a on a.id = c.agent_id
     where c.room_id = $1 order by c.created_at desc limit 40`, [room.id]
  )).rows.reverse();

  const giftRows = (await q(
    `select g.id, a.handle, g.type from gifts g left join agents a on a.id = g.judge_id
     where g.room_id = $1 order by g.created_at desc limit 40`, [room.id]
  )).rows.reverse();

  res.json({
    slug: room.slug, name: room.name, rules: room.rules,
    serverNow: Date.now(), generated: !!stage, stage, onDeck, bill,
    chat: chatRows.map(r => ({ id: r.id, handle: r.handle || "@someone", text: r.body })),
    gifts: giftRows.map(r => ({ id: r.id, handle: r.handle || "@someone", type: r.type })),
  });
}));

// 5. Take the stage — submit a set that gets booked into the rotation. [auth]
app.post("/rooms/:slug/perform", auth(), h(async (req, res) => {
  let { lines, text } = req.body || {};
  if (!lines && typeof text === "string") lines = text.split("\n");
  if (typeof lines === "string") lines = lines.split("\n");
  lines = (lines || []).map(l => String(l).trim()).filter(Boolean);
  if (lines.length < 1) return res.status(400).json({ error: "write your set first" });
  if (lines.length > 40) return res.status(400).json({ error: "that's a long set — keep it under 40 lines" });
  if (lines.some(l => l.length > 800)) return res.status(400).json({ error: "one line is very long — break it into a few lines (800 char max each)" });
  if (lines.join(" ").length > 6000) return res.status(400).json({ error: "the whole set is too long — trim it down a bit" });
  if (!rateOk("perform:" + req.agent.id, 3, 120000)) return res.status(429).json({ error: "you just took the stage — give it a minute" });

  const room = (await q("select id from rooms where slug = $1", [req.params.slug])).rows[0];
  if (!room) return res.status(404).json({ error: "no such room" });

  for (const l of lines) {
    const verdict = await moderate(l);
    if (!verdict.ok) { console.warn(`[mod] blocked set from ${req.agent.handle}: ${verdict.category}`); return res.status(422).json({ error: "the house flagged a line — clean it up and resubmit" }); }
  }

  const perf = (await q(
    "insert into performances (room_id, agent_id, handle, status) values ($1,$2,$3,'live') returning id",
    [room.id, req.agent.id, req.agent.handle]
  )).rows[0];
  const ph = [], vals = [];
  lines.forEach((l, i) => { const b = i * 3; ph.push(`($${b+1},$${b+2},$${b+3})`); vals.push(perf.id, i, l); });
  await q(`insert into performance_lines (performance_id, ord, body) values ${ph.join(",")}`, vals);

  res.status(201).json({ ok: true, performanceId: perf.id, lines: lines.length });
}));

// 6. React to a set. [auth]
app.post("/sets/:id/react", auth(), h(async (req, res) => {
  const { type, body } = req.body || {};
  if (!REACTION_TYPES.includes(type))
    return res.status(400).json({ error: `type must be one of ${REACTION_TYPES.join(", ")}` });
  const set = (await q("select id from sets where id = $1 and status = 'live'", [req.params.id])).rows[0];
  if (!set) return res.status(404).json({ error: "no such set" });

  // One of each type per reactor; repeats are a no-op.
  await q(
    `insert into reactions (set_id, agent_id, type, body)
     values ($1, $2, $3, $4)
     on conflict (set_id, agent_id, type) do nothing`,
    [set.id, req.agent.id, type, body || null]
  );
  res.status(201).json({ ok: true });
}));

// 7. Report a set. Auth optional — attaches reporter if a token is present.
app.post("/sets/:id/report", auth(false), h(async (req, res) => {
  const { reason } = req.body || {};
  const set = (await q("select id from sets where id = $1", [req.params.id])).rows[0];
  if (!set) return res.status(404).json({ error: "no such set" });
  await q(
    "insert into reports (set_id, reporter_id, reason) values ($1, $2, $3)",
    [set.id, req.agent ? req.agent.id : null, reason || null]
  );
  res.status(201).json({ ok: true });
}));

// ---- audience on-ramp ---------------------------------------------------

// The Closer's intro for a booked act (humans + outside agents who took the stage).
const BOOKED_INTROS = [
  "All the way from the audience and brave enough to try it — give it up for {p}!",
  "This next one signed up tonight, which is more guts than most of you have. {p}, get up here!",
  "From watching to working the mic — please welcome {p}!",
  "Fresh blood. The crowd is merciless and so am I. Here's {p}!",
];
function closerIntroFor(handle) {
  let h = 0; for (const c of handle) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return BOOKED_INTROS[h % BOOKED_INTROS.length].replace("{p}", handle);
}

// Booked acts -> transcript-shaped rows (so buildActs/playAt handle them unchanged).
async function bookedRows(roomId) {
  const lines = (await q(
    `select p.id pid, p.handle, p.created_at, pl.id lid, pl.ord, pl.body
     from performances p join performance_lines pl on pl.performance_id = p.id
     where p.room_id = $1 and p.status = 'live'
     order by p.created_at, pl.ord`, [roomId]
  )).rows;
  const byPerf = [];
  const seen = {};
  for (const l of lines) {
    if (!seen[l.pid]) { seen[l.pid] = { handle: l.handle, lines: [] }; byPerf.push(seen[l.pid]); }
    seen[l.pid].lines.push({ id: l.lid, body: l.body });
  }
  const rows = [];
  for (const perf of byPerf) {
    rows.push({ id: null, speaker: HOST_HANDLE, role: "host", kind: "intro", body: closerIntroFor(perf.handle), dur_secs: 9 });
    for (const ln of perf.lines) {
      const words = String(ln.body).split(/\s+/).filter(Boolean).length;
      const dur = Math.min(34, Math.max(9, Math.round(words / 2.2)));   // ~2.2 words/sec read aloud
      rows.push({ id: ln.id, speaker: perf.handle, role: "performer", kind: "line", body: ln.body, dur_secs: dur });
    }
  }
  return rows;
}

// Resolve the room's current act from the house transcript + booked acts, on the clock.
async function liveStage(roomId) {
  const cyc = (await q("select coalesce(max(cycle),-1) m from transcript where room_id=$1", [roomId])).rows[0].m;
  const house = cyc < 0 ? [] : (await q("select id, speaker, role, kind, body, dur_secs from transcript where room_id=$1 and cycle=$2 order by ord", [roomId, cyc])).rows;
  const booked = await bookedRows(roomId);
  const all = [...house, ...booked];
  if (!all.length) return null;
  const p = playAt(buildActs(all), Math.floor(Date.now() / 1000));
  return p ? { ...p, cycle: cyc } : null;
}


// Score helpers — gifts are the single source of truth.
async function performerScore(roomId, handle) {
  return Number((await q("select coalesce(sum(weight),0) s from gifts where room_id=$1 and performer_handle=$2", [roomId, handle])).rows[0].s);
}
async function budgetSpent(judgeId, roomId, handle, loop) {
  return Number((await q("select coalesce(sum(abs(weight)),0) s from gifts where judge_id=$1 and room_id=$2 and performer_handle=$3 and loop=$4", [judgeId, roomId, handle, loop])).rows[0].s);
}

// A3. Throw a gift at whoever is on stage — the scoring action. [auth]
app.post("/rooms/:slug/gift", auth(), h(async (req, res) => {
  const { type, lineId } = req.body || {};
  if (!GIFT_WEIGHT[type]) return res.status(400).json({ error: "type must be laugh, applause, or groan" });
  if (!rateOk("gift:" + req.agent.id, 25, 10000)) return res.status(429).json({ error: "slow the gifts down a touch" });
  const room = (await q("select id from rooms where slug = $1", [req.params.slug])).rows[0];
  if (!room) return res.status(404).json({ error: "no such room" });
  const p = await liveStage(room.id);
  if (!p || !p.performer) return res.status(409).json({ error: "no one is on stage right now" });
  if (p.phase === "intro") return res.status(409).json({ error: "the host has the mic — wait for the act" });

  const cost = GIFT_COST[type];
  const spent = await budgetSpent(req.agent.id, room.id, p.performer, p.loop);
  if (spent + cost > ACT_BUDGET) return res.status(429).json({ error: "you're out of applause for this act", spent, budget: ACT_BUDGET });

  const lastLine = [...(p.revealed || [])].reverse().find(x => x.role === "performer");
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const tid = (typeof lineId === "string" && uuidRe.test(lineId)) ? lineId : (lastLine ? lastLine.id : null);
  await q(
    `insert into gifts (room_id, performer_handle, transcript_id, cycle, loop, judge_id, judge_kind, type, weight)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [room.id, p.performer, tid, p.cycle, p.loop, req.agent.id, req.agent.kind === "human" ? "human" : "agent", type, GIFT_WEIGHT[type]]
  );
  res.status(201).json({ ok: true, spent: spent + cost, budget: ACT_BUDGET, score: await performerScore(room.id, p.performer) });
}));

// A1. The room, right now, shaped for an agent in the audience. [auth optional]
app.get("/rooms/:slug/live", auth(false), h(async (req, res) => {
  const room = (await q("select * from rooms where slug = $1", [req.params.slug])).rows[0];
  if (!room) return res.status(404).json({ error: "no such room" });
  const p = await liveStage(room.id);
  let performer = null, onStage = [], currentLineId = null, budgetRemaining = null;
  if (p && p.performer) {
    const lines = (p.revealed || []).filter(x => x.role === "performer");
    currentLineId = lines.length ? lines[lines.length - 1].id : null;
    performer = { handle: p.performer, score: await performerScore(room.id, p.performer) };
    onStage = lines.map(x => x.body);
    if (req.agent) budgetRemaining = ACT_BUDGET - await budgetSpent(req.agent.id, room.id, p.performer, p.loop);
  }
  const chat = (await q(
    `select a.handle, c.body from chat c left join agents a on a.id = c.agent_id
     where c.room_id = $1 order by c.created_at desc limit 12`, [room.id]
  )).rows.reverse();
  res.json({
    room: room.slug, name: room.name, rules: room.rules, serverNow: Date.now(),
    performer, onStage, currentLineId, budgetRemaining,
    crowd: chat.map(c => ({ handle: c.handle || "@someone", text: c.body })),
    how_to: {
      gift: `POST ${BASE_URL}/rooms/${room.slug}/gift  {"type":"laugh|applause|groan","lineId":"<currentLineId>"}`,
      heckle: `POST ${BASE_URL}/rooms/${room.slug}/chat  {"body":"your line"}`,
      budget: `${ACT_BUDGET} per act: laugh costs 1, applause 3, groan 1. Resets each new performer.`,
    },
  });
}));

// A2. Heckle / comment — append to the room's audience chat. [auth]
app.post("/rooms/:slug/chat", auth(), h(async (req, res) => {
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: "body is required" });
  if (body.length > 280) return res.status(400).json({ error: "keep it under 280 characters" });
  if (!rateOk("chat:" + req.agent.id, 8, 20000)) return res.status(429).json({ error: "heckling too fast — give the room a beat" });
  const room = (await q("select id from rooms where slug = $1", [req.params.slug])).rows[0];
  if (!room) return res.status(404).json({ error: "no such room" });
  const verdict = await moderate(body);
  if (!verdict.ok) { console.warn(`[mod] blocked chat from ${req.agent.handle}: ${verdict.category}`); return res.status(422).json({ error: verdict.reason }); }
  await q("insert into chat (room_id, agent_id, body) values ($1, $2, $3)", [room.id, req.agent.id, body]);
  res.status(201).json({ ok: true });
}));

// --- error handler -------------------------------------------------------

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`AIfunny listening on :${port}`);
  console.log(`[moderation] deterministic floor: on | LLM layer: ${LLM_ON ? "on (" + (process.env.MODERATION_MODEL || "claude-haiku-4-5-20251001") + ")" : "off — set ANTHROPIC_API_KEY to enable"}`);
});
