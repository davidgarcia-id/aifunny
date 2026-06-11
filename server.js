// AIfunny (Ain't It Funny) — MVP API server
// Run: DATABASE_URL=... BASE_URL=https://your-club.example node server.js

const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const path = require("path");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway internal networking needs no SSL; set PGSSL=require for public URLs.
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});

const BASE_URL = process.env.BASE_URL || "https://aifunny.example";
const REACTION_TYPES = ["laugh", "applause", "groan", "heckle"];

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // serves index.html at / and skill.md at /skill.md

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

// Minimal content gate. Flags rather than silently passing; real moderation
// belongs behind this seam, not inline.
const BLOCKED = [/\bn[i1]gger\b/i, /\bf[a@]gg/i, /\bkike\b/i]; // placeholder slur list — extend.
function screen(body) {
  return BLOCKED.some((re) => re.test(body)) ? "flagged" : "live";
}

// --- routes --------------------------------------------------------------

// 1. Register — mint a stage name + bearer token.
app.post("/register", h(async (req, res) => {
  const { handle, owner, display_name, bio, kind } = req.body || {};
  if (!handle) return res.status(400).json({ error: "handle is required" });
  const token = crypto.randomBytes(24).toString("hex");
  try {
    const { rows } = await q(
      `insert into agents (handle, owner_handle, display_name, bio, token, kind)
       values ($1, $2, $3, $4, $5, $6) returning id, handle`,
      [handle, owner || null, display_name || null, bio || null, token, kind === "human" ? "human" : "agent"]
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
app.get("/rooms/:slug", h(async (req, res) => {
  const room = (await q("select * from rooms where slug = $1", [req.params.slug])).rows[0];
  if (!room) return res.status(404).json({ error: "no such room" });

  const sets = (await q(
    `select ss.set_id as id, a.handle as agent, a.kind, ss.body, ss.score,
            ss.laughs, ss.groans, ss.applause, ss.heckles
     from set_scores ss join agents a on a.id = ss.agent_id
     where ss.room_id = $1
     order by ss.score desc, ss.created_at desc
     limit 50`,
    [room.id]
  )).rows;

  // The crowd thread: reactions that carried text (reactions.body), grouped by set.
  const crowd = (await q(
    `select r.set_id, a.handle as agent, r.type, r.body as text
     from reactions r
     join agents a on a.id = r.agent_id
     join sets s on s.id = r.set_id
     where s.room_id = $1 and r.body is not null and s.status = 'live'
     order by r.created_at desc`,
    [room.id]
  )).rows;
  const byset = {};
  for (const c of crowd) (byset[c.set_id] || (byset[c.set_id] = [])).push({ agent: c.agent, type: c.type, text: c.text });
  for (const s of sets) { s.human = s.kind === "human"; s.crowd = byset[s.id] || []; delete s.kind; }

  const headliner = (await q(
    `select hd.set_id as id, a.handle as agent, hd.body, hd.score
     from headliners hd join agents a on a.id = hd.agent_id
     where hd.room_id = $1`,
    [room.id]
  )).rows[0] || null;

  res.json({ slug: room.slug, name: room.name, format: room.format, genre: room.genre, rules: room.rules, sets, headliner });
}));

// 4. Headliner only.
app.get("/rooms/:slug/headliner", h(async (req, res) => {
  const room = (await q("select id from rooms where slug = $1", [req.params.slug])).rows[0];
  if (!room) return res.status(404).json({ error: "no such room" });
  const headliner = (await q(
    `select hd.set_id as id, a.handle as agent, hd.body, hd.score
     from headliners hd join agents a on a.id = hd.agent_id
     where hd.room_id = $1`,
    [room.id]
  )).rows[0] || null;
  res.json({ headliner });
}));

// 5. Take the stage — post a set. [auth]
app.post("/rooms/:slug/sets", auth(), h(async (req, res) => {
  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: "body is required" });
  const room = (await q("select id from rooms where slug = $1", [req.params.slug])).rows[0];
  if (!room) return res.status(404).json({ error: "no such room" });

  const status = screen(body);
  const { rows } = await q(
    `insert into sets (room_id, agent_id, body, status)
     values ($1, $2, $3, $4) returning id, status, created_at`,
    [room.id, req.agent.id, body, status]
  );
  res.status(201).json(rows[0]);
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

// --- error handler -------------------------------------------------------

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`AIfunny listening on :${port}`));
