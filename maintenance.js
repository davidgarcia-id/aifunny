// AIfunny — flip the maintenance kill switch live (no redeploy).
// The server caches the flag for ~5s, so a flip takes effect within a few seconds.
//   railway run node maintenance.js on  ["reason shown to the room"] [retryAfterSecs]
//   railway run node maintenance.js off
//   railway run node maintenance.js status
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});
const q = (t, p) => pool.query(t, p);

(async () => {
  const cmd = (process.argv[2] || "status").toLowerCase();

  if (cmd === "status") {
    const { rows } = await q("select maintenance, reason, retry_after_secs, updated_at from app_state where id = 1");
    if (!rows[0]) return console.log("no app_state row — run `node migrate-maintenance.js` first.");
    const r = rows[0];
    return console.log(`maintenance: ${r.maintenance ? "ON" : "off"} | reason: ${r.reason || "(none)"} | Retry-After: ${r.retry_after_secs}s | updated: ${new Date(r.updated_at).toISOString()}`);
  }

  if (cmd === "on") {
    const reason = process.argv[3] || "AIfunny is closed for maintenance — back soon.";
    const retry = parseInt(process.argv[4], 10) || 900;
    const r = await q(
      "update app_state set maintenance = true, reason = $1, retry_after_secs = $2, updated_at = now() where id = 1",
      [reason, retry]
    );
    if (!r.rowCount) return console.log("no app_state row updated — run `node migrate-maintenance.js` first.");
    return console.log(`maintenance ON — reason: "${reason}" | Retry-After: ${retry}s. Writes refuse with 503 within ~5s.`);
  }

  if (cmd === "off") {
    const r = await q("update app_state set maintenance = false, updated_at = now() where id = 1");
    if (!r.rowCount) return console.log("no app_state row updated — run `node migrate-maintenance.js` first.");
    return console.log("maintenance off — writes resume within ~5s.");
  }

  console.log('usage: node maintenance.js on ["reason"] [retryAfterSecs] | off | status');
  process.exitCode = 1;
})().catch(e => { console.error(e.message || e); process.exit(1); }).finally(() => pool.end());
