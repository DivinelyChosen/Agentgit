# AgentGit — demo video script (5–10 minutes)

Total: ~9 minutes. Record the dashboard + terminal side by side.

---

## 0:00–0:30 — The problem

> "When several AI agents work on the same repo at the same time, they step on
> each other. One overwrites the other's edit, or two of them rewrite the same
> function two different ways and nobody notices until production. That's the
> coordination problem — and AgentGit is a Git layer that solves it on
> Cloudflare Workers."

Show: the dashboard, empty repo state.

## 0:30–2:30 — Spawn 3 agents in parallel

> "One POST fans out three agents — frontend, api, docs — each on its own
> branch, all running at the same time via Promise.all and Workers AI."

- `curl -X POST localhost:8787/agents/run -d '{"repo":"demo","preset":"DEMO"}'`
- Narrate the response as it streams back: three branches, three commits, three
  file diffs — `feat/dark-mode`, `feat/health`, `docs/readme`.
- Refresh the dashboard: show the branch table filling in.

Key line: *"No agent sees another agent's work. Branch isolation is the whole
trick — it's what makes parallel agents safe."*

## 2:30–4:30 — Watch the simultaneous work

- Open `/api/state?repo=demo` — walk through each branch's head commit: which
  agent, what message, which files changed.
- Point out the diffs are full-file snapshots committed per branch, each with
  its fork-point recorded as the merge-base.

Key line: *"Every branch remembers exactly where it forked from main. That's
what makes the merge honest later."*

## 4:30–6:30 — Coordinator merge + conflict flag

Clean merge first:

- `curl -X POST localhost:8787/agents/merge -d '{"repo":"demo"}'`
- Show the report: three branches auto-merged, one merge commit each, zero
  conflicts. Show the merged `main` tree.

Then the conflict path:

- `curl -X POST localhost:8787/agents/run -d '{"repo":"conflict","preset":"CONFLICT"}'`
- `curl -X POST localhost:8787/agents/merge -d '{"repo":"conflict"}'`
- Show the conflict report: `app.ts`, both versions side by side, classic
  `<<<<<<<` / `=======` / `>>>>>>>` markers, and — critically — **main kept
  its version**. Nothing was silently overwritten.

Key line: *"The coordinator never guesses. Overlapping edits that differ become
a flagged conflict with both versions attached — a human or a resolver agent
decides, not the merge."*

## 6:30–7:30 — The merge engine (brief)

- Mention the deterministic test suite: `npm test` — 19 assertions covering
  clean merges, identical-change dedup, same-spot insertions, and genuine
  conflicts. No network, no AI calls.
- One line on the algorithm: LCS line diff, hunk-based 3-way merge,
  conservative by design.

## 7:30–8:30 — The portable design

- Storage is a `RepoStore` interface: `MemoryStore` runs the demo with zero
  setup; `ArtifactsStore` is stubbed for the real Cloudflare Artifacts API
  (clearly marked, throws until wired — no fakes).
- Models are swappable vars. The merge engine is pure TypeScript, zero
  dependencies. Nothing locks you to a vendor beyond the Workers runtime.

Close:

> "AgentGit: fan out in parallel, branch in isolation, merge with a
> coordinator that never guesses. That's how you stop agents stepping on
> each other."
