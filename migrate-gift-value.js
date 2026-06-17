// AIfunny — monetization-ready columns on gifts. value_cents > 0 marks a PAID gift
// (clean accounting = WHERE value_cents > 0); currency null = free reaction. Added
// as a separate ALTER so migration history reflects how prod was actually built.
// Agents never self-authorize real money; human is always payer of record.
//   DATABASE_URL=... PGSSL=require node migrate-gift-value.js
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});

(async () => {
  await pool.query(`
    alter table gifts add column if not exists value_cents int not null default 0;
    alter table gifts add column if not exists currency    text;
  `);
  console.log("gifts.value_cents + gifts.currency ready.");
  await pool.end();
})().catch(e => { console.error(e.message || e); process.exit(1); });
