# AgentGit — a Git coordination layer for parallel AI agents

The problem Cloudflare names: multiple AI agents working at the same time step
on each other. AgentGit is the coordination layer: agents fan out onto isolated
branches of one repo, and a coordinator Worker 3-way merges their diffs —
auto-merging the clean ones, flagging conflicts with both versions.

Built for the Cloudflare "Git for AI agents" contest (entries due Oct 14, 2026).

## How it works

```
POST /agents/run  ──▶  N agents IN PARALLEL (Promise.all)
                        each on its own branch, via Workers AI
                        → commits file diffs to its branch

POST /agents/merge ─▶  coordinator: 3-way merge every branch into main
                        (branch fork-point = merge-base)
                        clean → auto-merge commit on main
                        overlap → conflict flagged with BOTH versions
```

- **Branch storage** is behind a `RepoStore` interface (`src/store.ts`).
  - `MemoryStore` — zero setup, runs in `wrangler dev` today.
  - `ArtifactsStore` — real Cloudflare Artifacts backing: repos/forks/tokens
    over the Artifacts REST API, commits as genuine `git-receive-pack` pushes
    (the REST API is read-only for repo content, so writes go over Git Smart
    HTTP — commit ids are real git SHAs). Each AgentGit branch is an Artifacts
    repo forked from main (`<repo>--<branch>`); AgentGit metadata lives in
    `.agentgit/meta.json` inside each repo. The Worker picks ArtifactsStore
    automatically when `ARTIFACTS_ACCOUNT_ID` + `ARTIFACTS_API_TOKEN` are set
    (see "Artifacts setup" below).
- **Agents** (`src/agents.ts`) do exactly one job each: frontend, api, docs,
  tests. Strict JSON diff contract so output stays machine-readable.
- **Merge** (`src/merge.ts`) is pure line-based 3-way merge — no I/O, fully
  unit-tested. Conservative: differing overlaps become conflicts, never guesses.

## Setup

```bash
cd agent-git-entry
npm install
npx wrangler dev        # serves the dashboard at http://localhost:8787
```

No account, no secrets, no KV needed — the demo runs on `MemoryStore`.

## Artifacts setup (real Cloudflare backing)

`MemoryStore` is the default. To run on real Artifacts instead:

**1. Confirm Artifacts beta access on your account.**
Artifacts is in open beta. The fastest check is the API itself — after step 2,
run the probe in step 3. A `200` with a namespace list (even empty) means your
account has access; a `4xx` means it doesn't (request beta access via the
[Artifacts docs](https://developers.cloudflare.com/artifacts/)).

**2. Get your account ID and create an API token.**
- **Account ID:** log in at [dash.cloudflare.com](https://dash.cloudflare.com),
  pick your account — the 32-hex-character ID is in the URL and on the
  Workers & Pages overview page.
- **API token:** [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
  → **Create Token** → **Custom token** → **Get started**. Add one permission
  row: **Account → Artifacts → Edit** (Edit implies Read). Under **Account
  Resources** choose **Include → your account** (not "All accounts"). Create it
  and copy the value — it's shown once. (Permission set is community-verified
  against the current dashboard; if the dashboard labels differ slightly, pick
  the closest Artifacts permission.)

**3. Probe the API** (proves token + beta access in one shot):

```bash
export ACCOUNT_ID="<your-account-id>"
export CLOUDFLARE_API_TOKEN="<your-token>"
curl "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/artifacts/namespaces" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

**4. Wire the Worker.**

```bash
npx wrangler secret put ARTIFACTS_API_TOKEN   # paste the token, it stays secret
```

Add your account id to `wrangler.jsonc` under `vars`:

```jsonc
"vars": {
  "DEFAULT_MODEL": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "ARTIFACTS_ACCOUNT_ID": "<your-account-id>"
  // "ARTIFACTS_NAMESPACE": "agentgit"   // optional; this is the default
}
```

Then `npx wrangler dev` (or `deploy`). The Worker now uses ArtifactsStore.

**What it creates in your account:** one Artifacts repo per AgentGit repo
(`demo`), plus one forked repo per agent branch (`demo--feat-dark-mode` —
branch names are sanitized to `[A-Za-z0-9._-]`). Repos live in the `agentgit`
namespace (created automatically). `initRepo` wipes that repo's family first,
so demo re-runs are clean. Commits are real git commits — you can
`git clone https://x:<repo-token>@<account>.artifacts.cloudflare.net/git/agentgit/demo.git`
with a token minted from `POST /artifacts/namespaces/agentgit/tokens`.

**Notes:** one logical commit = two git pushes (content, then a metadata-sync
commit) because the REST API can't write files; the sync commits are invisible
to the API. Concurrent pushes to the same branch repo fail fast with a clear
error (the server's own ref check is the lock) — one agent per branch, which
is how the demo runs, never hits this.

## Run the demo

Open the dashboard, or drive the API directly:

```bash
# 1. Fan out 3 agents in parallel (frontend + api + docs, separate branches)
curl -X POST localhost:8787/agents/run \
  -H 'Content-Type: application/json' \
  -d '{"repo":"demo","preset":"DEMO"}'

# 2. Coordinator merges everything into main
curl -X POST localhost:8787/agents/merge \
  -H 'Content-Type: application/json' \
  -d '{"repo":"demo"}'

# 3. See the conflict path: two agents rewrite the same lines differently
curl -X POST localhost:8787/agents/run \
  -H 'Content-Type: application/json' \
  -d '{"repo":"conflict","preset":"CONFLICT"}'
curl -X POST localhost:8787/agents/merge \
  -H 'Content-Type: application/json' \
  -d '{"repo":"conflict"}'

# 4. Inspect state any time
curl 'localhost:8787/api/state?repo=demo'
```

Custom tasks work too — pass your own `tasks` array instead of `preset`:

```json
{"repo":"myrepo","tasks":[
  {"agent":"frontend","branch":"feat/nav","prompt":"Add a nav bar to app.ts"},
  {"agent":"tests","branch":"test/nav","prompt":"Write tests for the nav bar"}
]}
```

## Tests

```bash
npm test
```

Compiles `src/` and runs a deterministic fixture: 5 branches (clean merges,
identical-change dedup, and a genuine conflict), asserting the coordinator's
merge report. 19 assertions, no network, no AI calls.

## Prototype limits (by design)

- File moves are full-content snapshots, not patches; deletions aren't modeled.
- `MemoryStore` lives in the isolate — restarts wipe it. `ArtifactsStore`
  persists everything in real Artifacts repos (see "Artifacts setup").
- Model output is parsed defensively; a non-JSON reply commits nothing and is
  reported in the run result.

## Portability

Models are swappable vars (`DEFAULT_MODEL`). The store is an interface. The
merge engine is pure TypeScript with zero dependencies. Nothing here locks you
to a vendor beyond the Workers runtime itself.
