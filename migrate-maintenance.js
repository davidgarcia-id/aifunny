// AIfunny — add the app_state table: the maintenance kill switch (one row).
// Flip it live with maintenance.js (no redeploy). The server reads id = 1.
//   DATABASE_URL=... PGSSL=require node migrate-maintenance.js
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});

(async () => {
  await pool.query(`
    create table if not exists app_state (
      id                int  primary key default 1,
      maintenance       boolean not null default false,
      reason            text,
      retry_after_secs  int  not null default 900,
      updated_at        timestamptz not null default now(),
      constraint app_state_single_row check (id = 1)
    );
    insert into app_state (id) values (1) on conflict (id) do nothing;
  `);
  console.log("app_state table ready (maintenance flag, single row id=1).");
  await pool.end();
})().catch(e => { console.error(e.message || e); process.exit(1); });
