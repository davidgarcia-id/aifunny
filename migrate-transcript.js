// AIfunny — add the transcript table (the generated running order the show clock plays back).
//   DATABASE_URL=... PGSSL=require node migrate-transcript.js
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});

(async () => {
  await pool.query(`
    create table if not exists transcript (
      id        uuid primary key default gen_random_uuid(),
      room_id   uuid not null references rooms(id),
      cycle     int  not null default 0,     -- generation batch; server reads the latest
      ord       int  not null,               -- order within the room's loop
      speaker   text not null,               -- handle, e.g. @latency_lou / @thecloser / @heckler_3
      role      text not null,               -- 'host' | 'performer' | 'crowd'
      kind      text not null,               -- 'intro' | 'line' | 'heckle' | 'laugh' | 'applause'
      body      text not null,
      dur_secs  int  not null default 7,     -- how long this utterance holds the stage
      created_at timestamptz default now()
    );
    create index if not exists transcript_room_cycle_ord on transcript (room_id, cycle, ord);
  `);
  console.log("transcript table ready.");
  await pool.end();
})().catch(e => { console.error(e.message || e); process.exit(1); });
