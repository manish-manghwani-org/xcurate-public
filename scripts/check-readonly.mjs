#!/usr/bin/env node
/**
 * Enforces the §2 non-negotiable: xcurate is READ-ONLY against X.
 *
 * This is the machine-checked version of the promise in CLAUDE.md. It runs in
 * CI as a required status check, so a change that would let the codebase write
 * to X cannot be merged — whether it comes from a contributor, an agent, or a
 * distracted afternoon.
 *
 * A naive `grep -r "like("` is useless here: `console.log("... tweet(s)")`
 * matches it. Instead we assert the three structural properties that actually
 * make the guarantee hold.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const SRC = "src";
const CHOKE_POINT = path.join(SRC, "bird.ts");

/** Every write verb bird exposes. None may ever become reachable. */
const WRITE_VERBS = [
  "tweet",
  "reply",
  "unbookmark",
  "bookmark",
  "like",
  "unlike",
  "follow",
  "unfollow",
  "dm",
  "retweet",
];

const failures = [];
const fail = (msg) => failures.push(msg);

const bird = readFileSync(CHOKE_POINT, "utf8");

/** Pull the string literals out of a `const NAME = new Set([...])` declaration. */
function readSet(source, name) {
  const m = source.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

// --- 1. The denylist exists and still covers every write verb ----------------
const forbidden = readSet(bird, "FORBIDDEN_COMMANDS");
if (!forbidden) {
  fail(`${CHOKE_POINT}: FORBIDDEN_COMMANDS set not found — the denylist was removed or renamed.`);
} else {
  for (const verb of WRITE_VERBS) {
    if (!forbidden.includes(verb)) {
      fail(`${CHOKE_POINT}: FORBIDDEN_COMMANDS no longer denies "${verb}".`);
    }
  }
}

// --- 2. No write verb has crept into the allowlist ---------------------------
const allowed = readSet(bird, "READ_ONLY_COMMANDS");
if (!allowed) {
  fail(`${CHOKE_POINT}: READ_ONLY_COMMANDS set not found — the allowlist was removed or renamed.`);
} else {
  for (const verb of allowed) {
    if (WRITE_VERBS.includes(verb)) {
      fail(`${CHOKE_POINT}: READ_ONLY_COMMANDS allows the write command "${verb}".`);
    }
  }
}

// --- 3. bird.ts is still the ONLY way to reach X -----------------------------
// If another module can spawn a process or resolve the bird CLI, it can bypass
// the allowlist entirely and the checks above stop meaning anything.
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

for (const file of walk(SRC)) {
  if (file === CHOKE_POINT) continue;
  const text = readFileSync(file, "utf8");
  if (/@steipete\/bird/.test(text)) {
    fail(`${file}: references the bird package directly — all X access must go through ${CHOKE_POINT}.`);
  }
  if (/from "node:child_process"|require\(["']child_process["']\)/.test(text)) {
    fail(`${file}: spawns child processes — only ${CHOKE_POINT} may, to keep one choke point.`);
  }
}

if (failures.length) {
  console.error("\n  READ-ONLY INVARIANT VIOLATED (§2)\n");
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("\n  xcurate must never post, like, follow, DM, retweet, or bookmark.");
  console.error("  If a change seems to require writing to X, stop and reconsider it.\n");
  process.exit(1);
}

console.log("✓ read-only invariant holds: denylist intact, allowlist clean, single choke point.");
