/**
 * Deterministic fixture for the AgentGit merge engine.
 *
 * Run:  npx tsc --outDir /tmp/agent-git-dist && node test/fixture.mjs
 * (or:   npm test)
 *
 * No Workers AI calls — we commit canned diffs directly through MemoryStore
 * and run the real coordinator path (mergeRepoBranches).
 */
import { MemoryStore } from "/tmp/agent-git-dist/store.js";
import { mergeRepoBranches, mergeLines, splitLines } from "/tmp/agent-git-dist/merge.js";

let pass = 0;
let fail = 0;
function assert(cond, name) {
  if (cond) {
    pass++;
    console.log("  ok:", name);
  } else {
    fail++;
    console.log("  FAIL:", name);
  }
}

// ---------------------------------------------------------------- unit: mergeLines
console.log("unit: mergeLines");

{
  const base = splitLines("a\nb\nc\n");
  const ours = splitLines("a\nB\nc\n"); // change line 2
  const theirs = splitLines("a\nb\nC\n"); // change line 3
  const m = mergeLines(base, ours, theirs, "feat/x");
  assert(m.conflicts.length === 0, "non-overlapping edits merge with no conflicts");
  assert(m.lines.join("\n") === "a\nB\nC\n", "both edits present in output");
}

{
  const base = splitLines("a\nb\nc\n");
  const ours = splitLines("a\nB\nc\n");
  const theirs = splitLines("a\nB\nc\n"); // identical edit
  const m = mergeLines(base, ours, theirs, "feat/x");
  assert(m.conflicts.length === 0, "identical overlapping edits merge once, no conflict");
  assert(m.lines.join("\n") === "a\nB\nc\n", "identical edit applied once");
}

{
  const base = splitLines("a\nb\nc\n");
  const ours = splitLines("a\nB1\nc\n");
  const theirs = splitLines("a\nB2\nc\n");
  const m = mergeLines(base, ours, theirs, "feat/x");
  assert(m.conflicts.length === 1, "differing overlapping edits -> exactly 1 conflict");
  const txt = m.lines.join("\n");
  assert(
    txt.includes("<<<<<<< main") && txt.includes("=======") && txt.includes(">>>>>>> feat/x"),
    "conflict markers present with branch label",
  );
  assert(txt.includes("B1") && txt.includes("B2"), "both versions shown in conflict");
}

{
  const base = splitLines("a\nb\n");
  const ours = splitLines("X\na\nb\n"); // prepend X
  const theirs = splitLines("Y\na\nb\n"); // prepend Y (same spot, different text)
  const m = mergeLines(base, ours, theirs, "feat/x");
  assert(m.conflicts.length === 1, "two insertions at same position -> conflict");
}

{
  const base = splitLines("a\nb\n");
  const ours = splitLines("X\na\nb\n");
  const theirs = splitLines("X\na\nb\n"); // identical prepend
  const m = mergeLines(base, ours, theirs, "feat/x");
  assert(m.conflicts.length === 0, "identical insertions at same position -> no conflict");
}

// ---------------------------------------------------------------- integration
console.log("integration: 5 branches, coordinator merge");

const store = new MemoryStore();
await store.initRepo("demo", {
  "app.ts": 'export function renderApp() {\n  return "<h1>Hello</h1>";\n}\n',
  "api.ts": 'export function getStatus() {\n  return { ok: true };\n}\n',
  "README.md": "# Demo App\n",
});

const commitAs = (branch, agent, message, changes) =>
  store.commit("demo", branch, { agent, message, changes });

// A: frontend — prepend dark-mode lines to app.ts
await store.createBranch("demo", "feat/dark-mode", "main");
await commitAs("feat/dark-mode", "frontend", "dark mode toggle", [
  {
    path: "app.ts",
    content:
      'export const darkMode = false;\nexport function toggleDarkMode() {}\nexport function renderApp() {\n  return "<h1>Hello</h1>";\n}\n',
  },
]);

// B: api — append health endpoint to api.ts (non-conflicting with A)
await store.createBranch("demo", "feat/health", "main");
await commitAs("feat/health", "api", "health endpoint", [
  {
    path: "api.ts",
    content:
      'export function getStatus() {\n  return { ok: true };\n}\nexport function getHealth() {\n  return { status: "up" };\n}\n',
  },
]);

// C: docs — rewrite README (non-conflicting)
await store.createBranch("demo", "docs/readme", "main");
await commitAs("docs/readme", "docs", "document features", [
  { path: "README.md", content: "# Demo App\n\nDocs for dark mode and health.\n" },
]);

// D: rogue — prepend DIFFERENT lines at the same spot A used -> conflict on app.ts
await store.createBranch("demo", "feat/greeting-x", "main");
await commitAs("feat/greeting-x", "api", "theme experiment", [
  {
    path: "app.ts",
    content:
      'export const theme = "light";\nexport function getTheme() { return theme; }\nexport function renderApp() {\n  return "<h1>Hello</h1>";\n}\n',
  },
]);

// E: tests — byte-identical change to B's api.ts -> must merge clean, not conflict
await store.createBranch("demo", "feat/health-dup", "main");
await commitAs("feat/health-dup", "tests", "same health change", [
  {
    path: "api.ts",
    content:
      'export function getStatus() {\n  return { ok: true };\n}\nexport function getHealth() {\n  return { status: "up" };\n}\n',
  },
]);

const report = await mergeRepoBranches(store, "demo");

assert(
  ["feat/dark-mode", "feat/health", "docs/readme", "feat/health-dup"].every((b) =>
    report.mergedBranches.includes(b),
  ),
  "clean branches auto-merged (dark-mode, health, readme, health-dup)",
);
assert(report.conflicts.length === 1, "exactly one conflict reported");
assert(
  report.conflicts[0]?.path === "app.ts" && report.conflicts[0]?.branch === "feat/greeting-x",
  "conflict is app.ts on feat/greeting-x",
);
assert(
  report.conflicts[0]?.markerText.includes("<<<<<<< main") &&
    report.conflicts[0]?.markerText.includes(">>>>>>> feat/greeting-x"),
  "conflict carries both versions with markers",
);
assert(
  report.conflicts[0]?.oursText.includes("darkMode") &&
    report.conflicts[0]?.theirsText.includes("getTheme"),
  "conflict report exposes ours (darkMode) and theirs (getTheme) full texts",
);
assert(report.skippedBranches.length === 0, "no branches skipped");

const mainTree = await store.getTree("demo", (await store.getHead("demo", "main")).id);
assert(mainTree["api.ts"].includes("getHealth"), "merged api.ts has health endpoint");
assert(mainTree["README.md"].includes("Docs for dark mode"), "merged README has docs");
assert(mainTree["app.ts"].includes("darkMode"), "conflicted file keeps main's version");
assert(!mainTree["app.ts"].includes("getTheme"), "conflicted branch version NOT in main");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
