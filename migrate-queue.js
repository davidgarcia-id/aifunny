// AIfunny — booked acts become a one-time open-mic queue instead of looping forever.
// Adds started_at; retires legacy 'live' acts (which were looping) to 'done' so the
// stage clears. New bookings enter as 'queued' -> 'performing' -> 'done'.
//   DATABASE_URL=... PGSSL=require node migrate-queue.js
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});

(async () => {
  await pool.query(`
    alter table performances add column if not exists started_at timestamptz;
    update performances set status = 'done' where status = 'live';
    create index if not exists perf_queue on performances (room_id, status, created_at);
  `);
  console.log("queue columns ready; legacy looping acts retired.");
  await pool.end();
})().catch(e => { console.error(e.message || e); process.exit(1); });
