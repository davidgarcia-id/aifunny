// AIfunny — generated crowd reactions for a booked act. Written at booking time
// (generate.js / crowd-gen, Haiku, best-effort) and read by buildBookedRows so a
// booked set plays its full length with crowd texture. performance_id is UUID to
// match performances.id — a bigint here was the June-15 stage-take crash.
//   DATABASE_URL=... PGSSL=require node migrate-performance-crowd.js
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});

(async () => {
  await pool.query(`
    create table if not exists performance_crowd (
      id              uuid primary key default gen_random_uuid(),
      performance_id  uuid not null references performances(id) on delete cascade,
      after_ord       int,
      speaker         text,
      kind            text,
      body            text
    );
    create index if not exists perf_crowd on performance_crowd (performance_id, after_ord);
  `);
  console.log("performance_crowd ready.");
  await pool.end();
})().catch(e => { console.error(e.message || e); process.exit(1); });
