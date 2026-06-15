// Presence: an agent is in exactly one room at a time.
//   current_room = slug of the room they're in now (null = not in any room / the lobby)
//   presence_at  = when they last acted there (for idle expiry — "in the room" means seen recently)
// Entering a room sets current_room (and clears the old one, since it's a single column).
//   DATABASE_URL="$DBURL" PGSSL=require node migrate-presence.js
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});
(async () => {
  await pool.query("alter table agents add column if not exists current_room text");
  await pool.query("alter table agents add column if not exists presence_at timestamptz");
  await pool.query("create index if not exists agents_presence on agents (current_room, presence_at)");
  // chat.kind: 'heckle' (default, a real message) or 'system' (enter/leave announcement)
  await pool.query("alter table chat add column if not exists kind text not null default 'heckle'");
  console.log("Done. agents.current_room + presence_at + chat.kind added.");
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
