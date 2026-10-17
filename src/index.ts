/**
 * AgentGit — a Git coordination layer for parallel AI agents, on Workers.
 *
 *  POST /agents/run    fan out N agents IN PARALLEL; each works on its own
 *                      branch via Workers AI and commits file diffs.
 *  POST /agents/merge  coordinator: 3-way merge every branch into main,
 *                      auto-merge the clean ones, flag conflicts with both versions.
 *  GET  /              dashboard: branches, commits, merge status, demo buttons.
 *  GET  /api/state     JSON state for the dashboard.
 *
 * Portability law: models are swappable vars; the store is an interface
 * (MemoryStore runs today, ArtifactsStore when the account is wired).
 */

import { AGENTS, buildTaskPrompt, parseFileChanges, type AgentDef } from "./agents";
import { mergeRepoBranches } from "./merge";
import { ArtifactsStore, MemoryStore, type RepoStore } from "./store";

interface Env {
  AI: Ai;
  DEFAULT_MODEL?: string;
  ARTIFACTS_ACCOUNT_ID?: string; // Cloudflare account id (wrangler var)
  ARTIFACTS_API_TOKEN?: string; // set via `npx wrangler secret put ARTIFACTS_API_TOKEN`
  ARTIFACTS_NAMESPACE?: string; // optional; defaults to "agentgit"
}

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// ---------------------------------------------------------------------------
// Demo seed: a tiny app the agents collaborate on.
// ---------------------------------------------------------------------------

const DEMO_SEED: Record<string, string> = {
  "app.ts": [
    `export function renderApp() {`,
    `  return "<h1>Hello</h1>";`,
    `}`,
    ``,
  ].join("\n"),
  "api.ts": [
    `export function getStatus() {`,
    `  return { ok: true };`,
    `}`,
    ``,
  ].join("\n"),
  "README.md": [`# Demo App`, ``, `A tiny app for the AgentGit demo.`, ``].join("\n"),
};

interface DemoTask {
  agent: string;
  branch: string;
  prompt: string;
}

/** Happy path: five agents, five branches, no overlap → clean auto-merge. */
const DEMO_TASKS: DemoTask[] = [
  {
    agent: "frontend",
    branch: "feat/dark-mode",
    prompt:
      "Add a dark-mode toggle to app.ts: add an exported `darkMode` boolean " +
      "and a `toggleDarkMode()` function that flips it. Keep renderApp().",
  },
  {
    agent: "api",
    branch: "feat/health",
    prompt:
      "Add an exported `getHealth()` function to api.ts returning " +
      "{ status: 'up', version: '0.1.0' }. Keep getStatus().",
  },
  {
    agent: "docs",
    branch: "docs/readme",
    prompt:
      "Update README.md: document the dark-mode toggle and the health endpoint " +
      "as upcoming features.",
  },
  {
    agent: "tests",
    branch: "test/app-tests",
    prompt:
      "Create app.test.ts with tests verifying toggleDarkMode() flips the " +
      "darkMode boolean. Do not modify any other file.",
  },
  {
    agent: "security",
    branch: "fix/harden-api",
    prompt:
      "Harden api.ts: add an exported `sanitizeInput(input: string): string` " +
      "function that strips <, >, and & characters, and use it inside " +
      "getStatus(). Keep everything else.",
  },
];

/** Conflict path: two agents rewrite the same lines differently. */
const CONFLICT_TASKS: DemoTask[] = [
  {
    agent: "frontend",
    branch: "feat/greeting-a",
    prompt:
      "In app.ts, change renderApp() to return exactly `<h1>Hello dark</h1>` " +
      "and add an exported `toggleDarkMode()` function.",
  },
  {
    agent: "api",
    branch: "feat/greeting-b",
    prompt:
      "In app.ts, change renderApp() to return exactly `<h1>Hello light</h1>` " +
      "and add an exported `getTheme()` function returning 'light'.",
  },
];

// ---------------------------------------------------------------------------
// Store selection
// ---------------------------------------------------------------------------

let memStore: MemoryStore | null = null;

function getStore(env: Env): RepoStore {
  if (env.ARTIFACTS_ACCOUNT_ID && env.ARTIFACTS_API_TOKEN) {
    return new ArtifactsStore(env.ARTIFACTS_ACCOUNT_ID, env.ARTIFACTS_API_TOKEN, {
      namespace: env.ARTIFACTS_NAMESPACE,
    });
  }
  if (!memStore) memStore = new MemoryStore();
  return memStore;
}

// ---------------------------------------------------------------------------
// Agent fan-out
// ---------------------------------------------------------------------------

interface AgentRunResult {
  agent: string;
  branch: string;
  commitId: string | null;
  filesChanged: string[];
  ms: number;
  note?: string;
}

function extractText(res: unknown): string {
  if (typeof res === "string") return res;
  if (res && typeof res === "object") {
    const r = res as Record<string, unknown>;
    if (typeof r.response === "string") return r.response;
    if (typeof r.result === "string") return r.result;
  }
  return JSON.stringify(res);
}

async function runOneAgent(
  env: Env,
  store: RepoStore,
  repo: string,
  task: DemoTask,
): Promise<AgentRunResult> {
  const started = Date.now();
  const agent: AgentDef | undefined = AGENTS[task.agent];
  if (!agent) throw new Error(`unknown agent: ${task.agent}`);

  const mainHead = await store.getHead(repo, "main");
  const tree = await store.getTree(repo, mainHead ? mainHead.id : null);
  const model = env.DEFAULT_MODEL || DEFAULT_MODEL;

  const res = await env.AI.run(model as never, {
    messages: [
      { role: "system", content: agent.systemPrompt },
      { role: "user", content: buildTaskPrompt(agent, tree, task.prompt) },
    ],
  } as never);
  const parsed = parseFileChanges(extractText(res));

  let commitId: string | null = null;
  if (parsed.files.length > 0) {
    const c = await store.commit(repo, task.branch, {
      agent: task.agent,
      message: task.prompt.slice(0, 120),
      changes: parsed.files,
    });
    commitId = c.id;
  }

  return {
    agent: task.agent,
    branch: task.branch,
    commitId,
    filesChanged: parsed.files.map((f) => f.path),
    ms: Date.now() - started,
    note: parsed.note,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function runRoute(req: Request, env: Env): Promise<Response> {
  let body: {
    repo?: string;
    tasks?: DemoTask[];
    preset?: string;
    seed?: Record<string, string>;
    reset?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'send JSON: {"repo":"demo","tasks":[...]}' }, { status: 400 });
  }
  const repo = body.repo || "demo";
  const tasks = body.tasks?.length
    ? body.tasks
    : body.preset === "CONFLICT"
      ? CONFLICT_TASKS
      : DEMO_TASKS;
  const store = getStore(env);

  if (body.reset !== false) await store.initRepo(repo, body.seed ?? DEMO_SEED);

  // Create all branches up front (cheap, sequential), then fan out IN PARALLEL.
  for (const t of tasks) await store.createBranch(repo, t.branch, "main");
  const results = await Promise.all(
    tasks.map((t) => runOneAgent(env, store, repo, t)),
  );
  return Response.json({ ok: true, repo, parallel: true, results });
}

async function mergeRoute(req: Request, env: Env): Promise<Response> {
  let body: { repo?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'send JSON: {"repo":"demo"}' }, { status: 400 });
  }
  const store = getStore(env);
  const report = await mergeRepoBranches(store, body.repo || "demo");
  return Response.json({ ok: true, ...report });
}

async function stateRoute(req: Request, env: Env): Promise<Response> {
  const repo = new URL(req.url).searchParams.get("repo") || "demo";
  const store = getStore(env);
  if (!(await store.repoExists(repo))) {
    return Response.json({ repo, exists: false, branches: [] });
  }
  const branches = await store.listBranches(repo);
  const out = [];
  for (const b of branches) {
    const commits = await store.listCommits(repo, b.name);
    out.push({
      name: b.name,
      head: commits[0]
        ? {
            id: commits[0].id,
            agent: commits[0].agent,
            message: commits[0].message,
            createdAt: commits[0].createdAt,
            files: commits[0].changes.map((c) => c.path),
          }
        : null,
      commitCount: commits.length,
    });
  }
  return Response.json({ repo, exists: true, branches: out });
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function dashboard(): Response {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentGit — parallel agents, coordinated merges</title>
<style>
body{font-family:system-ui;max-width:900px;margin:2em auto;padding:0 1em;color:#1a1a1a}
h1{margin-bottom:.2em}.sub{color:#666;margin-top:0}
button{padding:.6em 1em;margin:.3em .3em .3em 0;cursor:pointer}
pre{background:#f4f4f4;padding:1em;overflow:auto;max-height:420px;white-space:pre-wrap}
table{border-collapse:collapse;width:100%;margin:1em 0}
td,th{border:1px solid #ddd;padding:.5em;text-align:left;font-size:.9em}
.badge{display:inline-block;padding:.15em .5em;border-radius:8px;font-size:.8em}
.ok{background:#d9f2d9}.warn{background:#ffe6b3}.bad{background:#ffd1d1}
.row{display:flex;gap:1em;flex-wrap:wrap}.card{border:1px solid #ddd;border-radius:8px;padding:1em;flex:1;min-width:220px}
code{background:#f4f4f4;padding:.1em .3em;border-radius:4px}
</style></head><body>
<h1>AgentGit</h1>
<p class="sub">A Git coordination layer for parallel AI agents — fan out, branch, merge.</p>

<div class="row">
<div class="card"><h3>1 · Run agents</h3>
<button onclick="runDemo('demo')">Run 3-agent demo</button>
<button onclick="runDemo('conflict')">Run conflict demo</button>
<p style="font-size:.85em;color:#666">Spawns agents <b>in parallel</b> (Promise.all), each on its own branch.</p></div>
<div class="card"><h3>2 · Merge</h3>
<button onclick="merge('demo')">Merge demo repo</button>
<button onclick="merge('conflict')">Merge conflict repo</button>
<p style="font-size:.85em;color:#666">Coordinator 3-way merges every branch into main. Clean ones auto-merge; overlaps get flagged with both versions.</p></div>
</div>

<h3>Repo state</h3>
<div><label>repo: <input id="repo" value="demo" size="12"></label>
<button onclick="refresh()">Refresh</button></div>
<table id="branches"><tr><th>Branch</th><th>Head commit</th><th>Agent</th><th>Files</th></tr></table>

<h3>Output</h3>
<pre id="out">Press a button to begin.</pre>

<script>
const out = document.getElementById('out');
function repo(){ return document.getElementById('repo').value || 'demo'; }
async function runDemo(which){
  out.textContent = 'Fanning out agents in parallel...';
  const tasks = which === 'conflict' ? 'CONFLICT' : 'DEMO';
  const r = await fetch('/agents/run', {method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({repo: repo(), preset: tasks, reset: true})});
  out.textContent = JSON.stringify(await r.json(), null, 2);
  refresh();
}
async function merge(){
  out.textContent = 'Coordinator merging...';
  const r = await fetch('/agents/merge', {method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({repo: repo()})});
  out.textContent = JSON.stringify(await r.json(), null, 2);
  refresh();
}
async function refresh(){
  const r = await fetch('/api/state?repo=' + encodeURIComponent(repo()));
  const s = await r.json();
  const t = document.getElementById('branches');
  t.innerHTML = '<tr><th>Branch</th><th>Head commit</th><th>Agent</th><th>Files</th></tr>';
  if(!s.exists){ t.innerHTML += '<tr><td colspan=4><i>repo not created yet — run the demo</i></td></tr>'; return; }
  for(const b of s.branches){
    const badge = b.name === 'main' ? '<span class="badge ok">main</span>' : '<span class="badge warn">agent</span>';
    t.innerHTML += '<tr><td>' + b.name + ' ' + badge + '</td><td>' +
      (b.head ? b.head.id + '<br><small>' + escapeHtml(b.head.message) + '</small>' : '<i>empty</i>') +
      '</td><td>' + (b.head ? b.head.agent : '') + '</td><td>' +
      (b.head ? b.head.files.join(', ') : '') + '</td></tr>';
  }
}
function escapeHtml(s){ return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
refresh();
</script>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/") return dashboard();
      if (req.method === "GET" && url.pathname === "/api/state") return stateRoute(req, env);
      if (req.method === "POST" && url.pathname === "/agents/run") return runRoute(req, env);
      if (req.method === "POST" && url.pathname === "/agents/merge") return mergeRoute(req, env);
      return new Response("not found", { status: 404 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "unknown error";
      return Response.json({ ok: false, error: msg }, { status: 500 });
    }
  },
};
