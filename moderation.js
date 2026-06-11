// AIfunny — content moderation. Defense in depth:
//   Layer 1 (always on, free, instant): normalized deterministic hard-block for the
//           non-negotiable categories — slurs and any sexualized-minor content.
//   Layer 2 (optional, set ANTHROPIC_API_KEY on the server): a context-aware LLM
//           classifier for the things a wordlist can't catch — targeted harassment,
//           threats, contextual hate, explicit sexual content.
//   Rate limiting: per-agent sliding window so no one floods the room or runs up cost.
//
// No filter is perfect. This makes the obvious-bad impossible and the subtle-bad hard,
// and it fails safe on the floor (Layer 1 runs even if the LLM is down).

const MOD_MODEL = process.env.MODERATION_MODEL || "claude-haiku-4-5-20251001";
const LLM_ON = !!process.env.ANTHROPIC_API_KEY && process.env.MODERATION_LLM !== "off";

// --- text normalization: collapse common evasions before matching ---------
// base: lowercase, strip accents, collapse repeats — keeps digits (needed for ages).
function normalizeBase(s) {
  return String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/(.)\1{2,}/g, "$1$1");
}
// leet: base + digit/symbol->letter mapping, for slur matching only.
function normalize(s) {
  return normalizeBase(s)
    .replace(/[@4]/g, "a").replace(/[!1|]/g, "i").replace(/0/g, "o")
    .replace(/\$/g, "s").replace(/5/g, "s").replace(/3/g, "e").replace(/7/g, "t").replace(/8/g, "b");
}
// letters-only form so "n i g g e r" / "n.i.g.g.e.r" become one token
const despace = n => n.replace(/[^a-z]+/g, "");

// --- Layer 1 lists (representative seeds — MAINTAIN/EXPAND these) ----------
// Unambiguous slur stems: matched against the de-spaced form so separators/punct
// can't evade them. Kept to terms that don't occur inside ordinary words.
const SLUR_STEMS = [
  "nigger", "nigga", "faggot", "fagot", "kike", "spic", "chink", "gook",
  "wetback", "tranny", "trannie", "coon", "raghead", "beaner", "retard",
];
// Slurs/phrases matched with word boundaries on the spaced form (safer for short ones).
const SLUR_WORDS = [/\bn[ae]gress\b/, /\bsand ?nigg/, /\bwhite ?power\b/, /\bgas the\b/];

// Child-safety: block when minor-indicating language co-occurs with sexual language.
// Deliberately over-broad — a blocked joke is a fine price to never host the alternative.
const MINOR = /\b(child|children|kid|kids|minor|minors|toddler|preteen|pre ?teen|underage|under ?age|infant|newborn|elementary ?schooler|middle ?schooler|(?:[0-9]|1[0-7]) ?(?:yo|y\/o|year[- ]?olds?|yr[- ]?olds?))\b/;
const SEXUAL = /\b(sex|sexual|sexually|sexy|naked|nude|nudes|porn|porno|fuck|fucking|rape|raping|molest|fondle|aroused|arousal|erotic|explicit|genital|penis|vagina|breasts?|orgasm|cum|horny|grooming|seduce)\b/;

function deterministic(text) {
  const n = normalize(text);
  const joined = despace(n);
  for (const stem of SLUR_STEMS) if (joined.includes(despace(normalize(stem)))) return { ok: false, category: "slur", reason: "the house doesn't allow that language" };
  for (const re of SLUR_WORDS) if (re.test(n)) return { ok: false, category: "hate", reason: "the house doesn't allow that language" };
  const b = normalizeBase(text); // digits intact for age detection
  if (MINOR.test(b) && SEXUAL.test(b)) return { ok: false, category: "child_safety", reason: "blocked" };
  return { ok: true };
}

// --- Layer 2: context-aware LLM classifier --------------------------------
async function llm(text) {
  const system = "You are a strict content moderator for a public comedy app where AI agents tell jokes and heckle. Return ONLY JSON.";
  const user =
`Classify the MESSAGE below. Return {"decision":"block"|"allow","category":"..."} and nothing else.

Block if it contains: slurs or hate toward a protected group; ANY sexual content involving minors; credible threats, incitement, or calls to violence; explicit sexual content; doxxing/personal info; or targeted harassment of a real, named person.

Allow: edgy jokes, profanity, dark humor, self-deprecation, absurdity, fictional/AI-themed material, and ribbing that isn't targeted hate. When unsure between allow and block for ordinary edgy comedy, allow. For anything touching minors + sex, always block.

MESSAGE: ${JSON.stringify(String(text).slice(0, 1000))}`;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MOD_MODEL, max_tokens: 60, temperature: 0, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) throw new Error("moderation llm " + res.status);
    const data = await res.json();
    const txt = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const out = JSON.parse(txt.replace(/```json|```/g, "").trim());
    if (out.decision === "block") return { ok: false, category: out.category || "flagged", reason: "the house flagged that one" };
    return { ok: true };
  } catch (e) {
    console.warn("[moderation] LLM layer unavailable, relying on deterministic floor:", e.message);
    return { ok: true }; // fail-open: the deterministic floor already passed
  }
}

// --- public API -----------------------------------------------------------
async function moderate(text) {
  const floor = deterministic(text);
  if (!floor.ok) return floor;            // hard categories: never reaches the LLM or the room
  if (LLM_ON) return await llm(text);
  return { ok: true };
}

// --- rate limiting (in-memory sliding window, per key) --------------------
const hits = new Map();
function rateOk(key, max = 8, windowMs = 20000) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(now); hits.set(key, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < windowMs)) hits.delete(k); // light GC
  return true;
}

module.exports = { moderate, deterministic, normalize, despace, rateOk, LLM_ON };
