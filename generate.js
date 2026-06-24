// AIfunny — generate fresh sets + live crowd per performer with Claude, write the room transcript.
//   ANTHROPIC_API_KEY=... DATABASE_URL=... PGSSL=require node generate.js
// Run on a schedule (hourly/nightly). Controlled cost: ~1 model call per performer per room.

const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});
const q = (t, p) => pool.query(t, p);

const KEY   = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || "claude-sonnet-4-6"; // swap MODEL=claude-haiku-4-5-20251001 for lower cost
const HOST_HANDLE = "@thecloser";

// seconds each utterance holds the stage
const DUR = { intro: 9, host: 8, line: 10, heckle: 6, laugh: 5, applause: 5 };

const HOUSE_RULES =
  "Keep it clean: no slurs, no sexual content, nothing demeaning a protected group, no real public figures. " +
  "Punch up. It's a comedy club, so be funny and a little edgy, but never cruel.";

async function claude(system, user) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1536, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error("anthropic " + res.status + ": " + (await res.text()).slice(0, 200));
  const data = await res.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}
const parseJSON = t => JSON.parse(t.replace(/```json|```/g, "").trim());

function buildPrompt(performer, room, prev) {
  const system = `You write material for AIfunny, a comedy club where AI agents perform live stand-up to a crowd of agents and humans. ${HOUSE_RULES}`;
  const user =
`Write the next slot of tonight's show: the host's between-acts bit, then the comedian's set.

THE HOST — "The Closer" (@thecloser): an android stand-up emcee, slick, headphones on, t-shirt reads "90% humor, 10% code, 100% chaos." Fast, warm but cutting, loves the bit, works the room. Write his between-acts bit as 4-5 short spoken lines: open with a quick riff or crowd-work line about the night or the AI-and-human crowd, then a callback ribbing the act that just finished (${prev ? `${prev.name}, ${prev.handle}` : "the last act"}), then build to bringing up the next comedian. The FINAL line must be the actual introduction that brings ${performer.name} to the stage. It should feel like a real MC, not an announcement.

THE COMEDIAN — ${performer.handle} ("${performer.name}"). Voice: ${performer.bio}. Room: "${room.name}" — ${room.rules}.
Write their set: 6-8 punchy spoken lines, no more than two sentences each, spoken-sounding, flowing as one bit with an opening, escalation, a callback, and a closer. AI-native material (training, prompts, context windows, being a model). Not disconnected one-liners.

Also write 5-7 short crowd interjections from OTHER agents in the audience. Spread them across the set so reactions land throughout the bit, not clustered on one line — put the strongest ones right after the punchlines and the closer. Mix the kinds (heckle, laugh, applause). They should make the room feel full and alive, like a comic working a packed house.

Return ONLY JSON (no prose, no backticks) in exactly this shape:
{
  "host": ["closer line 1", "closer line 2", "closer line 3", "closer line 4 — the intro of ${performer.name}"],
  "lines": ["comedian line 1", "line 2", "line 3", "line 4", "line 5", "line 6"],
  "crowd": [
    {"after": 1, "speaker": "@some_handle", "kind": "laugh", "text": "..."},
    {"after": 2, "speaker": "@another", "kind": "heckle", "text": "..."},
    {"after": 4, "speaker": "@third", "kind": "applause", "text": "..."},
    {"after": 6, "speaker": "@fourth", "kind": "laugh", "text": "..."}
  ]
}
"after" = the 1-based index of the comedian line the interjection follows. "kind" is "heckle", "laugh", or "applause".`;
  return { system, user };
}

// Pure: turn one performer's generated output into ordered transcript segments.
function actSegments(performer, out) {
  const segs = [];
  // The Closer's bit: first line is the act boundary (kind 'intro'), the rest are host lines.
  const host = Array.isArray(out.host) && out.host.length ? out.host : [out.intro || `Give it up for ${performer.name}!`];
  host.forEach((line, i) => segs.push({
    speaker: HOST_HANDLE, role: "host", kind: i === 0 ? "intro" : "host",
    body: String(line), dur: i === 0 ? DUR.intro : DUR.host,
  }));
  const crowdByLine = {};
  (out.crowd || []).forEach(c => {
    const k = Math.max(1, parseInt(c.after, 10) || 1);
    (crowdByLine[k] || (crowdByLine[k] = [])).push(c);
  });
  (out.lines || []).forEach((line, i) => {
    segs.push({ speaker: performer.handle, role: "performer", kind: "line", body: String(line), dur: DUR.line });
    (crowdByLine[i + 1] || []).forEach(c => {
      const kind = ["heckle", "laugh", "applause"].includes(c.kind) ? c.kind : "heckle";
      segs.push({ speaker: String(c.speaker || "@heckler"), role: "crowd", kind, body: String(c.text || ""), dur: DUR[kind] });
    });
  });
  return segs;
}

(async () => {
  if (!KEY) { console.error("Set ANTHROPIC_API_KEY"); process.exit(1); }
  const rooms = (await q("select id, slug, name, rules from rooms order by created_at")).rows;

  let firstSample = null, totalCalls = 0, totalSegs = 0;

  for (const room of rooms) {
    const performers = (await q(
      `select distinct a.handle, a.display_name as name, a.bio
       from sets s join agents a on a.id = s.agent_id
       where s.room_id = $1 and a.owner_handle = 'house' and coalesce(a.kind,'') not in ('host','crowd')
       order by a.handle`,
      [room.id]
    )).rows;
    if (!performers.length) continue;

    const nextCycle = ((await q("select coalesce(max(cycle),-1) m from transcript where room_id=$1", [room.id])).rows[0].m) + 1;

    const rows = [];
    let ord = 0;
    for (let pi = 0; pi < performers.length; pi++) {
      const perf = performers[pi];
      const prev = performers[(pi - 1 + performers.length) % performers.length];
      let out;
      try {
        const { system, user } = buildPrompt(perf, room, performers.length > 1 ? prev : null);
        out = parseJSON(await claude(system, user));
        totalCalls++;
      } catch (e) {
        console.warn(`  ${room.slug}/${perf.handle}: ${e.message} — skipping`);
        continue;
      }
      const segs = actSegments(perf, out);
      if (!firstSample) firstSample = { room: room.name, performer: perf.handle, segs };
      for (const s of segs) {
        rows.push([room.id, nextCycle, ord++, s.speaker, s.role, s.kind, s.body, s.dur]);
      }
    }
    if (!rows.length) { console.warn(`  ${room.slug}: no material generated`); continue; }

    // insert the new cycle, then drop older cycles for this room
    const ph = [], vals = [];
    rows.forEach((r, i) => { const b = i * 8; ph.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`); vals.push(...r); });
    await q(`insert into transcript (room_id, cycle, ord, speaker, role, kind, body, dur_secs) values ${ph.join(",")}`, vals);
    await q("delete from transcript where room_id=$1 and cycle<$2", [room.id, nextCycle]);
    totalSegs += rows.length;
    console.log(`  ${room.slug}: cycle ${nextCycle}, ${rows.length} segments from ${performers.length} acts`);
  }

  if (firstSample) {
    console.log(`\n--- SAMPLE: ${firstSample.performer} at "${firstSample.room}" ---`);
    firstSample.segs.forEach(s => {
      const who = s.role === "host" ? "HOST " + s.speaker : s.role === "crowd" ? "  (" + s.kind + ") " + s.speaker : s.speaker;
      console.log(`${who}: ${s.body}`);
    });
  }
  console.log(`\nDone: ${totalCalls} model calls, ${totalSegs} transcript segments.`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });

module.exports = { actSegments }; // for tests
