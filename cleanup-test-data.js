// AIfunny — surgical test-data purge. Removes test/smoke identities and everything they
// generated, leaving rooms, the house cast, and real users untouched.
//
// DRY RUN (default — shows what WOULD be deleted, changes nothing):
//   DATABASE_URL="$DBURL" PGSSL=require node cleanup-test-data.js
// COMMIT (actually deletes):
//   DATABASE_URL="$DBURL" PGSSL=require node cleanup-test-data.js --commit
//
// "Test" = any agent whose handle matches these patterns. Add more as needed.
const TEST_PATTERNS = [
  "@smoke\\_%",      // @smoke_aud, @smoke_31006, ...
  "@owner\\_test%",
  "@gift\\_test%",
  "@link\\_check%",
  "@test\\_%",
  "@mod\\_test%",
  "@david\\_test%",
];

const { Pool } = require("pg");
const COMMIT = process.argv.includes("--commit");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});

// Build a WHERE fragment matching any test pattern (case-insensitive), using LIKE with \ escapes.
const likeOr = (col) => "(" + TEST_PATTERNS.map((_, i) => `${col} ILIKE $${i + 1} ESCAPE '\\'`).join(" OR ") + ")";

(async () => {
  const c = await pool.connect();
  try {
    // Identify the test agents (by handle) and their owners.
    const agents = (await c.query(`select id, handle, owner_id from agents where ${likeOr("handle")}`, TEST_PATTERNS)).rows;
    const handles = agents.map(a => a.handle);
    const agentIds = agents.map(a => a.id);
    const ownerIds = [...new Set(agents.map(a => a.owner_id).filter(Boolean))];

    if (!handles.length) { console.log("No test agents match the patterns. Nothing to do."); return; }

    // Count what we'd remove (gifts/chat key off handle or agent_id; performances off agent_id).
    const n = async (sql, params) => (await c.query(sql, params)).rows[0].n;
    const giftsByJudge   = await n(`select count(*)::int n from gifts where judge_id = any($1)`, [agentIds]).catch(() => 0);
    const giftsByPerf    = await n(`select count(*)::int n from gifts where ${likeOr("performer_handle")}`, TEST_PATTERNS).catch(() => 0);
    const chatN          = await n(`select count(*)::int n from chat where agent_id = any($1)`, [agentIds]).catch(() => 0);
    const perfN          = await n(`select count(*)::int n from performances where agent_id = any($1)`, [agentIds]).catch(() => 0);

    console.log(`\n${COMMIT ? "DELETING" : "DRY RUN — would delete"}:`);
    console.log(`  test agents:        ${handles.length}  ${handles.join(", ")}`);
    console.log(`  their owners:       ${ownerIds.length}`);
    console.log(`  gifts (as judge):   ${giftsByJudge}`);
    console.log(`  gifts (as perf'r):  ${giftsByPerf}`);
    console.log(`  chat messages:      ${chatN}`);
    console.log(`  performances:       ${perfN}  (+ their lines & crowd, via cascade)`);
    console.log("  KEPT: rooms, house cast, transcript, and every non-test user.\n");

    if (!COMMIT) { console.log("Dry run only. Re-run with --commit to delete."); return; }

    await c.query("begin");
    // performances cascade to performance_lines + performance_crowd (FK on delete cascade)
    await c.query(`delete from performances where agent_id = any($1)`, [agentIds]);
    await c.query(`delete from gifts where judge_id = any($1)`, [agentIds]);
    await c.query(`delete from gifts where ${likeOr("performer_handle")}`, TEST_PATTERNS);
    await c.query(`delete from chat where agent_id = any($1)`, [agentIds]);
    await c.query(`delete from agents where id = any($1)`, [agentIds]);
    if (ownerIds.length) {
      // only drop owners that now have no remaining agents
      await c.query(`delete from owners o where o.id = any($1) and not exists (select 1 from agents a where a.owner_id = o.id)`, [ownerIds]);
    }
    await c.query("commit");
    console.log("Done. Test data purged; rooms, house cast, and real data intact.");
  } catch (e) {
    await c.query("rollback").catch(() => {});
    console.error("Failed (rolled back):", e.message);
    process.exit(1);
  } finally {
    c.release();
    await pool.end();
  }
})();
