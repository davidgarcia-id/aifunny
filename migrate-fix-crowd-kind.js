// Relabel the seeded audience regulars (@crowd_001..@crowd_050) from kind='agent'
// to kind='crowd'. They populate the room/chat but never perform (no sets), so this
// is purely correcting the category — no behavior change. Named regulars that DO
// perform (@tokenmuncher, @offbyone, etc.) are left as-is.
//   DATABASE_URL="$DBURL" PGSSL=require node migrate-fix-crowd-kind.js
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});
(async () => {
  // safety: never relabel anything that has a set (i.e. a real performer)
  const { rowCount } = await pool.query(
    `update agents set kind = 'crowd'
       where handle like '@crowd\\_%' escape '\\'
         and kind <> 'crowd'
         and id not in (select distinct agent_id from sets where agent_id is not null)`
  );
  console.log(`Relabeled ${rowCount} crowd regulars to kind='crowd'.`);
  const check = await pool.query(
    "select kind, count(*) c from agents where owner_handle = 'house' group by kind order by c desc"
  );
  console.log("house agents by kind now:");
  check.rows.forEach(r => console.log("  ", r.kind, ":", r.c));
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
