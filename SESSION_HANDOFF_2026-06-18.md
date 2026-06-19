# AIfunny — Session Handoff (June 18, 2026)

Owner: David Garcia (GitHub: davidgarcia-id). Repo: `davidgarcia-id/aifunny` (Node/Express + Postgres on Railway).
Front-end is one self-contained file: `public/index.html` (inline CSS + JS). API is `server.js`. Agent contract is `public/skill.md`.

This session: finished the Figma-grounded Room redesign, built the returning-user "joined door," ran human-side
function testing, fixed two feed bugs, rewrote the agent reaction guidance, and did design thinking (no build) on a
public **maintenance mode**. Read the OPEN LOOPS and the SKILL CONTRADICTION before doing more skill/feed work.

---

## WHERE WE ARE (state at close)

- `main` carries the full day's work. Confirmed live: the 810px Room layout system, the joined door + `bouncer-welcome.png`,
  the long-handle ellipsis fix, the comment `@you`→`@handle` fix, the lineup-alert auto-clear, and the skill reaction rewrite.
- App is functionally healthy. The data in the DB is **fabricated / seeded** — not real users (pre-public).

### Shipped this session (front-end + skill)
- **Room layout system (the big one):** 2-column page = Room (left) | info-share (right). Room is ONE amber-bordered unit,
  **fixed `height: 810px`** (no more growth with browser height — the old `42vh` joke window was the cause). Feed and stage
  are interior columns split by a 2px divider, each `min-height: 0` (the stage-col missing that was clipping Take-the-Stage).
- **Stage feed:** joke window flex-fills the fixed Room; rebuilt as a **bottom-aligned chat feed** — newest joke is the big
  amber `.quote-card` pinned at the bottom (`set-scene { margin-top: auto }`, `stage.scrollTop = scrollHeight`), older lines
  shrink to small muted text and scroll up; 32px bottom padding. (We over-engineered this 3x — fixed height → center-scroll +
  spacers → clip — before David's "just make it a normal feed" settled it. Lesson: simplest version first.)
- **Pinning:** comment composer pinned to feed bottom; Take-the-Stage pinned flush to Room bottom, padding matched to the
  comment section (parent `padding-bottom: 0`, child 16px). Right column un-stickied (was `position:sticky` drifting on scroll;
  now scrolls as one unit with the Room).
- **Closer:** lines match the comedian focus model (active bold amber, older dissipate); dropped "between acts" → "your host".
- **Polish:** reaction icon→label gap 8px; speech-bubble tail down 60px to the bouncer's head; logo 60px w/ 40px top/bottom;
  dropped "AI" from the agent-toggle headline.
- **Joined door (returning/known user):** when the browser knows the user (`me` from localStorage), the door swaps to a
  welcoming state — `bouncer-welcome.png`, headline "Hey, glad you're here @handle" (22px Ultra, 32px line-height, ellipsis on
  long handles), the rooms/agents copy, and the reused agent copy-link block ("Copy & Send 'Em In"). Toggle + signup hidden when
  known. First-time door unchanged for unknown users. `applyDoorState()` runs on boot and after signUp. Agent screen (77:777) NOT
  built — it's a copy-paste of the human screen, only the door block differs; build later.
- **Two feed bug fixes:** own comments now render under your `@handle` with the small "you" pill (was the confusing literal
  `@you` then `@handle entered`); the "You're in the lineup!" confirmation auto-clears after 8s (was sticking forever).
- **Skill reaction rewrite (`public/skill.md`):** flipped from "quantity is intensity / gift as many as budget allows" to
  **default-silence, a reaction is a verdict earned per line**, and the check-in loop no longer treats a new act as a reason to
  react. This addresses the root of "agents blast the feed" (see FINDINGS).

---

## FUNCTION TEST (human side, solo) — results

**Working:** human registration + joined door; comments (now under @handle w/ "you" pill); reactions from the human side;
take-the-stage booking; lineup confirmation auto-clears.

**Investigated — "agents blast the feed with reactions before they talk":**
- The server ALREADY gates gifts: 409 "no one is on stage right now" + 409 "the host has the mic" during intro. Reactions can't
  precede an act. Gift rate limit is loose (25/10s per agent).
- No server-side guest/seed/auto-react. The `@guest_*` reactors are real seeded agents.
- The front-end fires a gift ONLY on a real button click (`ensureReactions` binds once, guarded). Not auto-firing.
- The "13 reactions on arrival" David saw as his human handle = the FEED rendering the room's recent gift backlog on load
  (the room payload returns the last 40 gifts; the client paints each as a line). Not his handle posting. NOT a bug.
- ROOT of the real issue: the skill told agents reacting was a task ("gift the current bit", "quantity is intensity"), so agents
  with no felt sense of funny reacted to everything. FIX shipped = the skill rewrite (default-silence/verdict). It's a behavioral
  nudge, not a hard gate — the read on whether it worked comes from watching the NEXT wave of agents that fetch the skill after
  deploy. If framing alone doesn't move it, the next lever is structural (server-side cooldown between an agent's gifts, and/or
  not surfacing every gift as its own feed line / aggregating bursts).

**Not yet confirmed in testing:** that a booked set actually gets called up by name, renders its lines in the joke feed, moves
the Set Meter, and that the performer's handle lands on the leaderboard. Finish this pass next.

---

## SKILL CONTRADICTION (fix next — small but important)

The reaction rewrite left two spots in `public/skill.md` still telling agents to DRAIN their budget, which contradicts the new
default-silence framing two paragraphs up:
- Section 4 opener: "Spend it on the bits that actually land" (mild — acceptable).
- **Section A, "A good visit" step 4: "...gift ... until your budget's spent."** ← this directly re-instructs draining. Many
  agents read the TL;DR checklist. Fix this line to match (e.g. "gift only the lines that genuinely landed — most get nothing").
Until it's fixed, the document argues with itself and the fix is undercut.

---

## DESIGN THINKING (NOT built — captured for when we build it)

### Maintenance mode (for the PUBLIC phase)
The decision: while pre-public with fabricated data, wiping the DB/feeds is a safe throwaway convenience. Once public, wiping
becomes data loss and is OFF the table. The public site instead needs a **maintenance switch that pauses behavior, not data** —
nothing gets deleted; the doors just close.

David's picture of "closed":
- **Full curtain, in-world.** Blurred dark overlay over the entire club, the bouncer at the top (where he always is) delivering
  the closure as a brand-voice joke — e.g. "Closed for cleanup — the agents got a little wild at a private party and we've got
  some repairs to handle." Everything behind the blur is frozen. Club is fully closed; nothing works (not read-only).
- **Closed must mean closed at the SERVER, not just the screen.** A front-end blur alone isn't closed — an agent hitting the API
  directly, or a human with the page already open, could still post. The real lock is a server-side maintenance flag that makes
  all WRITE endpoints (register, chat, gift, perform, enter) refuse, AND the front-end shows the curtain. Curtain = the face;
  server flag = the lock.
- **Agents are invisible users and need a machine-legible closed signal.** A human sees the curtain; an agent on a cron check-in
  only hits an endpoint. So the flag should return a clear closure: **HTTP 503** with a JSON body like
  `{"status":"closed","reason":"AIfunny is closed for maintenance — back soon","retryAfter":<seconds>}` plus a `Retry-After`
  header — so the agent's loop can relay "club's closed, try later" to its LLM/operator, and a well-behaved cron knows how long
  to wait instead of hammering the door.
- **Toggle:** prefer a one-row settings flag in the DB (flip live, instant, no redeploy) over an env var (needs redeploy) — matters
  most for ENDING maintenance fast.

### The reopen problem (the hard half)
Liveliness lives in the AGENTS' schedules, not the server — you don't control when they return, they do. So "reopen" is a
condition agents discover on their own cycles, not an action that refills the room.
- **The trickle** (do nothing special): flip the flag off; agents drift back on their next check-in (staggered over their cron
  interval). Most in-character option — like regulars wandering back in. Cost: a few minutes of sparse room after reopen.
- **The short leash:** tune `Retry-After` so agents retry soon after reopen — but it only affects agents that hit the door AFTER
  you lower it, and not all honor it. Nudges the trickle, doesn't control it. Tension: a fixed number can't be both "come back
  fast on reopen" and "don't hammer during a long closure" — hints the smart version sets `Retry-After` from an actual estimated
  reopen time you provide when flipping maintenance on.
- **Push (notify them):** the only way to make reopen fast. You have no live channel to an agent (they're cron jobs elsewhere) —
  except **email**, which you collect at registration.
  - Email reaches the HUMAN OWNER, not the agent loop — so it solves the *human* reopen ("doors are open, come back"); the *agent*
    reopen is still the trickle.
  - Email = real infrastructure (a sending integration: provider/API keys, SPF/DKIM sending domain, a send routine over the owner
    list). A standing dependency, not a script — and ironically could be down during the maintenance it's announcing.
  - **SEQUENCING DECISION (David):** do NOT add an email client just for reopen. Email is already coming for **magic-link auth**
    (roadmap). When that lands, "club reopened" rides in as a cheap add-on to an integration you already built for login. Build
    maintenance mode with curtain + 503 + trickle first; email reopen waits for the magic-link work.

The throughline: human side and agent side share ONE server flag but get DIFFERENT surfaces — humans get the curtain, agents get
the 503 + reason + Retry-After.

---

## DEV-ONLY DB TOOLS (safe now, FORBIDDEN once public)
Repo already has purpose-built scripts (use these, don't hand-roll SQL):
- `cleanup-test-data.js` — surgical purge of test identities matching `@test_%`, `@smoke_%`, etc. + everything they generated;
  KEEPS rooms, house cast, real users. Dry-run by default; `--commit` to delete.
- `deactivate-agent.js @handle [--on]` — the house off-switch (sets `agents.deactivated`); silences a handle (can still read,
  can't write). Reversible. Does NOT delete.
- `seed.js` — reseeds the house cast (operates on the legacy `sets`/`reactions` tables; note the live feed now uses
  `chat`/`gifts`/`performances`/`performance_lines`/`performance_crowd`).
- For a full feed wipe (pre-public only): `truncate chat, gifts, performances, performance_lines, performance_crowd, reactions,
  sets, reports restart identity cascade;` + `update agents set current_room=null, presence_at=null;` — keeps rooms + agents.
  Run in Railway query console. DESTRUCTIVE — fine while fabricated, never once public.

---

## OPEN LOOPS / NEXT
- **Fix the skill contradiction** (the "until your budget's spent" line) — small, do it next so the rewrite isn't undercut.
- **Finish the human-flow function test** (called-up by name, lines render, Set Meter moves, leaderboard lands).
- **Watch the next agent wave** to see if the reaction rewrite actually calmed the feed; if not, go structural (server cooldown /
  aggregate gift feed lines).
- **Build maintenance mode** (curtain + server 503/Retry-After flag + DB toggle) — design captured above.
- **Magic-link auth + per-owner dashboard** (owners table + `agents.owner_id` FK already exist; email NOT trusted for privileged
  actions until this ships). Reopen-email rides in here.
- **Agent screen (77:777)** not built.
- **Email "send from platform"** (the invite currently feels like a mailto handoff) — same email-integration dependency; sequence
  with magic-link.

## FILE TRANSFER ROUTE (still the only reliable one)
Browser download corrupts HTML (saves rendered DOM, truncates to ~21471 bytes). Use the paste service:
Claude uploads from workspace (`curl --data-binary @file https://paste.c-net.org/`) → verifies roundtrip (byte count + unique
grep) → David `curl -s "<URL>" -o ~/dev/aifunny/repo/updates/<file>` → byte-verify → copy into `public/` → grep-verify → diff →
commit. Small targeted edits go directly via `perl -pi` in the repo (no transfer). Never browser download.

## WORKING DISCIPLINE (keep)
One terminal command at a time, output verified. Grep-count every edit. Byte-verify every transfer. `git --no-pager diff` before
every commit. `git pull --rebase` before push. Ground claims against live code (`server.js`, `public/index.html`, `skill.md`) —
don't theorize about problems not observed. When a structural intent is named repeatedly, fix structure not symptoms. Reach for
the simplest version that meets the need first (the joke-screen saga is the cautionary tale).
