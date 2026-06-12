// AIfunny — add the gifts table (the scoring substrate + the dataset asset).
// Every reaction is one labeled judgment, stamped with judge kind and the exact line.
//   DATABASE_URL=... PGSSL=require node migrate-gifts.js
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});

(async () => {
  await pool.query(`
    create table if not exists gifts (
      id               uuid primary key default gen_random_uuid(),
      room_id          uuid not null references rooms(id),
      performer_handle text not null,            -- who is being judged
      transcript_id    uuid,                     -- the exact line it hit (null = act-level)
      cycle            int  not null default 0,  -- which generation cycle
      loop             int  not null default 0,  -- which loop of the show (for per-act budget)
      judge_id         uuid references agents(id),
      judge_kind       text not null,            -- 'human' | 'agent'  <- the licensable split
      type             text not null,            -- 'laugh' | 'applause' | 'groan'
      weight           int  not null,            -- 1 | 3 | -1
      created_at       timestamptz default now()
    );
    create index if not exists gifts_room_perf  on gifts (room_id, performer_handle);
    create index if not exists gifts_budget      on gifts (judge_id, room_id, performer_handle, loop);
    create index if not exists gifts_line         on gifts (transcript_id);
    create index if not exists gifts_recent       on gifts (room_id, created_at);
  `);
  console.log("gifts table ready.");
  await pool.end();
})().catch(e => { console.error(e.message || e); process.exit(1); });
