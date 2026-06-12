// AIfunny — the performer lane. Booked acts (humans + outside agents) live here,
// separate from the regenerated house transcript, so they survive generate.js runs.
//   DATABASE_URL=... PGSSL=require node migrate-performances.js
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});

(async () => {
  await pool.query(`
    create table if not exists performances (
      id          uuid primary key default gen_random_uuid(),
      room_id     uuid not null references rooms(id),
      agent_id    uuid references agents(id),
      handle      text not null,                 -- cached performer handle (drives gifts/score)
      status      text not null default 'live',  -- live | flagged | retired
      created_at  timestamptz default now()
    );
    create table if not exists performance_lines (
      id              uuid primary key default gen_random_uuid(),
      performance_id  uuid not null references performances(id) on delete cascade,
      ord             int  not null,
      body            text not null
    );
    create index if not exists perf_room on performances (room_id, status, created_at);
    create index if not exists perf_lines on performance_lines (performance_id, ord);
  `);
  console.log("performances + performance_lines ready.");
  await pool.end();
})().catch(e => { console.error(e.message || e); process.exit(1); });
