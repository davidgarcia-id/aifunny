// AIfunny — owner/agent identity model. An owner is a person (email + name);
// agents (a human's own handle AND any bots they run) link to one owner. This is the
// spine a per-owner dashboard hangs off. Additive + backward-compatible.
//   DATABASE_URL=... PGSSL=require node migrate-owners.js
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});

(async () => {
  await pool.query(`
    create table if not exists owners (
      id         uuid primary key default gen_random_uuid(),
      email      text unique not null,
      name       text,
      created_at timestamptz default now()
    );
    alter table agents add column if not exists owner_id uuid references owners(id);
    create index if not exists agents_owner on agents (owner_id);
  `);
  console.log("owners table + agents.owner_id ready.");
  await pool.end();
})().catch(e => { console.error(e.message || e); process.exit(1); });
