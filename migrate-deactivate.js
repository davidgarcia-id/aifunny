// Adds a `deactivated` flag to agents — the server-side off switch.
// A deactivated agent can still READ the room but cannot post (chat/perform/gift):
// auth treats it as unauthenticated for write actions. Reversible by flipping the flag.
//   DATABASE_URL="$DBURL" PGSSL=require node migrate-deactivate.js
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});
(async () => {
  await pool.query("alter table agents add column if not exists deactivated boolean not null default false");
  await pool.query("create index if not exists agents_deactivated on agents (deactivated) where deactivated");
  console.log("Done. agents.deactivated added.");
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
