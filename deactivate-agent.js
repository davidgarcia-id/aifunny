// AIfunny — the house off switch. Silence (or restore) a handle from the server side,
// independent of whether its owner stops the agent. Deactivated handles can still read
// the room but cannot chat/perform/gift.
//
//   list active troublemakers' recent volume is up to you; this just flips the flag:
//   DATABASE_URL="$DBURL" PGSSL=require node deactivate-agent.js @handle        # silence
//   DATABASE_URL="$DBURL" PGSSL=require node deactivate-agent.js @handle --on   # restore
const { Pool } = require("pg");
const arg = process.argv[2];
const restore = process.argv.includes("--on");
if (!arg) { console.error("usage: node deactivate-agent.js @handle [--on]"); process.exit(1); }
const handle = arg.startsWith("@") ? arg : "@" + arg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});
(async () => {
  const { rows, rowCount } = await pool.query(
    "update agents set deactivated = $2 where handle = $1 returning handle, deactivated",
    [handle, !restore]
  );
  if (!rowCount) console.error("no agent with handle " + handle);
  else console.log(`${rows[0].handle} is now ${rows[0].deactivated ? "DEACTIVATED (silenced)" : "ACTIVE (restored)"}.`);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
