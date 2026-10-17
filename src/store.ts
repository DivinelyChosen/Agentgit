/**
 * RepoStore — branch/commit storage behind one interface.
 *
 * Two implementations:
 *  - MemoryStore:    zero-setup, runs in `wrangler dev` today. Module-level
 *                    state persists across requests in the same isolate.
 *                    (Swap for a KV-backed store in production — same interface.)
 *  - ArtifactsStore: Cloudflare Artifacts, wired for real:
 *                      * control plane over the Artifacts REST API
 *                        (repos, forks, tokens, namespaces, file reads), and
 *                      * writes via the Git Smart HTTP protocol
 *                        (`git-receive-pack`) — the REST API is read-only for
 *                        repo content, so commits are real pushes.
 *
 * ArtifactsStore mapping (documented, git-native):
 *  - One AgentGit repo   -> one Artifacts repo (the "main" repo).
 *  - One AgentGit branch -> one Artifacts repo forked from main at branch
 *    creation time ("fork a project for each agent" is the documented
 *    Artifacts pattern). Repo name: `<repo>--<branch>` (sanitized).
 *  - One AgentGit commit -> one real git commit on that repo's `main`
 *    branch, pushed over HTTPS. Commit ids ARE git SHAs.
 *  - AgentGit-level metadata (seed files, commit agents/messages/changes,
 *    branch fork points) lives in `.agentgit/meta.json`, committed into each
 *    repo. Each logical commit is pushed as TWO git commits: the content
 *    commit, then a metadata-sync commit (`agentgit: sync metadata`). The
 *    sync commits are invisible at the RepoStore layer (getHead/listCommits/
 *    getTree only ever surface content commits) but keep every repo fully
 *    self-describing — clone one and the history is real.
 *
 * Portability note: the RepoStore interface is unchanged, so MemoryStore
 * still works everywhere. Nothing here depends on Workers beyond the runtime
 * itself (fetch, crypto.subtle, CompressionStream, btoa).
 */

export interface FileChange {
  path: string;
  content: string; // full new file content (snapshot, not a patch)
}

export interface CommitInput {
  agent: string;
  message: string;
  changes: FileChange[];
}

export interface Commit extends CommitInput {
  id: string;
  parent: string | null;
  createdAt: number;
}

export interface BranchInfo {
  name: string;
  head: string | null;
  forkedFrom: string | null; // commit id of main at fork time (merge-base)
}

export interface RepoStore {
  /** (Re)initializes a repo, wiping any existing state. Demo-friendly. */
  initRepo(repo: string, files: Record<string, string>): Promise<void>;
  repoExists(repo: string): Promise<boolean>;
  createBranch(repo: string, branch: string, fromBranch?: string): Promise<void>;
  listBranches(repo: string): Promise<BranchInfo[]>;
  commit(repo: string, branch: string, input: CommitInput): Promise<Commit>;
  getHead(repo: string, branch: string): Promise<Commit | null>;
  /** Full file tree at a commit; null = initial seed tree. */
  getTree(repo: string, commitId: string | null): Promise<Record<string, string>>;
  listCommits(repo: string, branch: string): Promise<Commit[]>;
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

interface RepoData {
  seed: Record<string, string>;
  commits: Map<string, Commit>;
  branches: Map<string, { head: string | null; forkedFrom: string | null }>;
  seq: number;
}

export class MemoryStore implements RepoStore {
  private repos = new Map<string, RepoData>();

  private data(repo: string): RepoData {
    const d = this.repos.get(repo);
    if (!d) throw new Error(`repo not found: ${repo}`);
    return d;
  }

  async initRepo(repo: string, files: Record<string, string>): Promise<void> {
    this.repos.set(repo, {
      seed: { ...files },
      commits: new Map(),
      branches: new Map([["main", { head: null, forkedFrom: null }]]),
      seq: 0,
    });
  }

  async repoExists(repo: string): Promise<boolean> {
    return this.repos.has(repo);
  }

  async createBranch(repo: string, branch: string, fromBranch = "main"): Promise<void> {
    const d = this.data(repo);
    const from = d.branches.get(fromBranch);
    if (!from) throw new Error(`branch not found: ${fromBranch}`);
    if (!d.branches.has(branch)) {
      d.branches.set(branch, { head: from.head, forkedFrom: from.head });
    }
  }

  async listBranches(repo: string): Promise<BranchInfo[]> {
    const d = this.data(repo);
    return [...d.branches.entries()].map(([name, b]) => ({
      name,
      head: b.head,
      forkedFrom: b.forkedFrom,
    }));
  }

  async commit(repo: string, branch: string, input: CommitInput): Promise<Commit> {
    const d = this.data(repo);
    const b = d.branches.get(branch);
    if (!b) throw new Error(`branch not found: ${branch}`);
    const id = `c${++d.seq}_${Date.now().toString(36)}`;
    const c: Commit = { ...input, id, parent: b.head, createdAt: Date.now() };
    d.commits.set(id, c);
    b.head = id;
    return c;
  }

  async getHead(repo: string, branch: string): Promise<Commit | null> {
    const d = this.data(repo);
    const b = d.branches.get(branch);
    if (!b || !b.head) return null;
    return d.commits.get(b.head) ?? null;
  }

  async getTree(repo: string, commitId: string | null): Promise<Record<string, string>> {
    const d = this.data(repo);
    const tree: Record<string, string> = { ...d.seed };
    if (!commitId) return tree;
    const chain: Commit[] = [];
    let cur: string | null = commitId;
    while (cur) {
      const c = d.commits.get(cur);
      if (!c) break;
      chain.unshift(c);
      cur = c.parent;
    }
    for (const c of chain) {
      for (const ch of c.changes) tree[ch.path] = ch.content;
    }
    return tree;
  }

  async listCommits(repo: string, branch: string): Promise<Commit[]> {
    const d = this.data(repo);
    const b = d.branches.get(branch);
    if (!b) return [];
    const out: Commit[] = [];
    let cur: string | null = b.head;
    while (cur) {
      const c = d.commits.get(cur);
      if (!c) break;
      out.push(c);
      cur = c.parent;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Git primitives (pure — unit-tested against real git object hashes)
// ---------------------------------------------------------------------------

export const ZERO_SHA = "0".repeat(40);

/** Standard Cloudflare v4 API envelope. */
interface V4Envelope<T> {
  result?: T | null;
  success?: boolean;
  errors?: { code: number; message: string }[];
}

const te = new TextEncoder();
const td = new TextDecoder();

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** SHA-1 hex of bytes (git object ids). */
export async function sha1Hex(data: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(data); // fresh ArrayBuffer for BufferSource typing
  const digest = await crypto.subtle.digest("SHA-1", copy.buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Raw git object bytes: `<type> <len>\0<content>`. */
export function encodeGitObject(
  type: "blob" | "tree" | "commit",
  content: Uint8Array,
): Uint8Array {
  return concatBytes(te.encode(`${type} ${content.length}\0`), content);
}

export interface GitObject {
  typeNum: 1 | 2 | 3; // 1=commit, 2=tree, 3=blob
  raw: Uint8Array; // full object bytes INCLUDING the `<type> <len>\0` header
  sha: string;
}

/**
 * Build blob + tree objects for a flat path->content map (nested paths OK).
 * Returns the root tree SHA and every object (caller decides the pack).
 */
export async function buildGitTrees(
  files: Record<string, string>,
): Promise<{ rootSha: string; objects: GitObject[] }> {
  const objects: GitObject[] = [];
  const blobShas = new Map<string, string>();
  for (const [path, content] of Object.entries(files)) {
    const raw = encodeGitObject("blob", te.encode(content));
    const sha = await sha1Hex(raw);
    blobShas.set(path, sha);
    objects.push({ typeNum: 3, raw, sha });
  }

  interface DirNode {
    files: Map<string, string>;
    dirs: Map<string, DirNode>;
  }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, sha] of blobShas) {
    const parts = path.split("/").filter((p) => p.length > 0);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let sub = node.dirs.get(parts[i]);
      if (!sub) {
        sub = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], sub);
      }
      node = sub;
    }
    node.files.set(parts[parts.length - 1], sha);
  }

  const encodeNode = async (node: DirNode): Promise<string> => {
    const entries: { mode: string; name: string; sha: string }[] = [];
    for (const [name, sha] of node.files) entries.push({ mode: "100644", name, sha });
    for (const [name, sub] of node.dirs)
      entries.push({ mode: "40000", name, sha: await encodeNode(sub) });
    // git tree sort: names compared byte-wise, dirs as if trailing "/"
    entries.sort((a, b) => {
      const ka = a.name + (a.mode === "40000" ? "/" : "");
      const kb = b.name + (b.mode === "40000" ? "/" : "");
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const parts: Uint8Array[] = [];
    for (const e of entries) {
      parts.push(te.encode(`${e.mode} ${e.name}\0`));
      parts.push(hexToBytes(e.sha));
    }
    const raw = encodeGitObject("tree", concatBytes(...parts));
    const sha = await sha1Hex(raw);
    objects.push({ typeNum: 2, raw, sha });
    return sha;
  };

  const rootSha = await encodeNode(root);
  return { rootSha, objects };
}

/** Raw git commit object bytes for a tree. parentSha null/zeros = root commit. */
export function buildGitCommit(
  treeSha: string,
  parentSha: string | null,
  agent: string,
  timestampMs: number,
  message: string,
): Uint8Array {
  const ts = Math.floor(timestampMs / 1000);
  const safe = agent.replace(/[<>\n\r]/g, "_").slice(0, 64) || "agentgit";
  const ident = `${safe} <${safe}@agentgit>`;
  const lines = [`tree ${treeSha}`];
  if (parentSha && parentSha !== ZERO_SHA) lines.push(`parent ${parentSha}`);
  lines.push(`author ${ident} ${ts} +0000`, `committer ${ident} ${ts} +0000`, ``, message);
  return encodeGitObject("commit", te.encode(lines.join("\n") + "\n"));
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate"); // zlib wrapper — correct for packfiles
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();
  const chunks: Uint8Array[] = [];
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  })();
  await writer.write(Uint8Array.from(data));
  await writer.close();
  await pump;
  return concatBytes(...chunks);
}

function encodePackObjectHeader(typeNum: number, size: number): Uint8Array {
  const out: number[] = [];
  let b = (typeNum << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) b |= 0x80;
  out.push(b);
  while (size > 0) {
    let nb = size & 0x7f;
    size >>>= 7;
    if (size > 0) nb |= 0x80;
    out.push(nb);
  }
  return new Uint8Array(out);
}

/**
 * Build a packfile (pack v2, no deltas — every object stored whole).
 * No-delta packs are always valid; the server just stores them.
 */
export async function buildPack(objects: GitObject[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [te.encode("PACK"), u32be(2), u32be(objects.length)];
  for (const o of objects) {
    // Packfiles store the object *content* only; the "type len\0" header
    // lives in loose objects (and is what the SHA is computed over), not here.
    const nul = o.raw.indexOf(0);
    if (nul < 0) throw new Error("buildPack: GitObject raw missing header");
    const content = o.raw.slice(nul + 1);
    parts.push(encodePackObjectHeader(o.typeNum, content.length));
    parts.push(await deflateRaw(content));
  }
  const body = concatBytes(...parts);
  const trailer = new Uint8Array(
    await crypto.subtle.digest("SHA-1", Uint8Array.from(body).buffer),
  );
  return concatBytes(body, trailer);
}

// ---------------------------------------------------------------------------
// Git Smart HTTP (receive-pack, protocol v1 — the only push flavor Artifacts
// supports). Pure protocol framing + thin fetch wrappers; unit-tested with
// mocked fetch.
// ---------------------------------------------------------------------------

/** One pkt-line: 4-hex length (including itself) + payload. */
export function encodePktLine(s: string): Uint8Array {
  const body = te.encode(s);
  return concatBytes(te.encode((body.length + 4).toString(16).padStart(4, "0")), body);
}

export const PKT_FLUSH = te.encode("0000");

/** Parse text pkt-lines; flush packets come back as "". */
export function parsePktLines(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i + 4 <= text.length) {
    const head = text.slice(i, i + 4);
    if (head === "0000") {
      out.push("");
      i += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!len || Number.isNaN(len) || i + len > text.length) break;
    out.push(text.slice(i + 4, i + len));
    i += len;
  }
  return out;
}

export interface AdvertisedRefs {
  refs: Map<string, string>; // refname -> sha
  capabilities: Set<string>; // from the first ref line's \0 section
}

export function parseAdvertisedRefs(discoveryText: string): AdvertisedRefs {
  const refs = new Map<string, string>();
  const capabilities = new Set<string>();
  for (const line of parsePktLines(discoveryText)) {
    const m = /^([0-9a-f]{40}) ([^\0\n]+?)(?:\0([^\n]*))?\n?$/.exec(line);
    if (!m) continue; // skips the "# service=..." banner line
    refs.set(m[2], m[1]);
    if (m[3])
      for (const c of m[3].trim().split(/\s+/)) if (c) capabilities.add(c);
  }
  return { refs, capabilities };
}

function gitAuthHeader(repoToken: string): string {
  // Repo tokens (art_v1_...?expires=...) authenticate git routes as Basic x:<token>.
  return "Basic " + btoa(`x:${repoToken}`);
}

export async function discoverRefs(
  remote: string,
  repoToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AdvertisedRefs> {
  const res = await fetchImpl(`${remote}/info/refs?service=git-receive-pack`, {
    headers: { Authorization: gitAuthHeader(repoToken) },
  });
  if (!res.ok)
    throw new Error(`Artifacts git: ref discovery failed (HTTP ${res.status}) for ${remote}`);
  return parseAdvertisedRefs(await res.text());
}

export interface GitPushParams {
  remote: string;
  repoToken: string;
  ref: string; // e.g. "refs/heads/main"
  oldSha: string; // ZERO_SHA when the ref does not exist yet
  newSha: string;
  pack: Uint8Array;
  fetchImpl?: typeof fetch;
}

/** Push one pack to a git remote. Throws on rejection; the server's own
 *  old-sha check is the concurrency control (a lost race comes back `ng`). */
export async function gitPush(p: GitPushParams): Promise<void> {
  const fetchImpl = p.fetchImpl ?? fetch;
  const auth = gitAuthHeader(p.repoToken);
  const { capabilities } = await discoverRefs(p.remote, p.repoToken, fetchImpl);
  const reportStatus = capabilities.has("report-status");
  const cmd = `${p.oldSha} ${p.newSha} ${p.ref}\0${reportStatus ? "report-status" : ""}\n`;
  const body = concatBytes(encodePktLine(cmd), PKT_FLUSH, p.pack);
  const res = await fetchImpl(`${p.remote}/git-receive-pack`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/x-git-receive-pack-request",
    },
    body: body as BodyInit,
  });
  if (!res.ok)
    throw new Error(`Artifacts git: receive-pack failed (HTTP ${res.status}) for ${p.remote}`);
  let sawRefOk = false;
  for (const raw of parsePktLines(await res.text())) {
    const line = raw.trim();
    if (line.startsWith("unpack ") && line !== "unpack ok")
      throw new Error(`Artifacts git: unpack failed: ${line}`);
    else if (line.startsWith("ok ")) sawRefOk = true;
    else if (line.startsWith("ng "))
      throw new Error(`Artifacts git: push rejected: ${line.slice(3)}`);
  }
  if (reportStatus && !sawRefOk)
    throw new Error(`Artifacts git: no "ok" status for ${p.ref} in push response`);
}

// ---------------------------------------------------------------------------
// ArtifactsStore — real Cloudflare Artifacts backing
// ---------------------------------------------------------------------------

export interface ArtifactsStoreOptions {
  /** Artifacts namespace. Defaults to "agentgit". */
  namespace?: string;
  /** Test hook — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const API_BASE = "https://api.cloudflare.com/client/v4";
const DEFAULT_NAMESPACE = "agentgit";
const META_PATH = ".agentgit/meta.json";
const META_SYNC_MESSAGE = "agentgit: sync metadata";
const MAIN_GIT_BRANCH = "main";

interface MetaCommitEntry {
  sha: string;
  parent: string | null;
  agent: string;
  message: string;
  changes: FileChange[];
  createdAt: number;
}

interface RepoMeta {
  version: 1;
  repo: string; // exact AgentGit repo name
  branch: string; // exact AgentGit branch name
  forkedFrom: string | null; // content-commit sha of the source at fork time
  seed: Record<string, string>;
  commits: MetaCommitEntry[];
}

function sanitizeRepoName(s: string): string {
  const clean = s.replace(/[^A-Za-z0-9._-]/g, "-");
  return clean || "repo";
}

function replayFiles(
  seed: Record<string, string>,
  commits: MetaCommitEntry[],
  uptoSha?: string,
): Record<string, string> {
  const tree: Record<string, string> = { ...seed };
  for (const c of commits) {
    for (const ch of c.changes) {
      if (!ch.path.startsWith(".agentgit/")) tree[ch.path] = ch.content;
    }
    if (uptoSha !== undefined && c.sha === uptoSha) break;
  }
  return tree;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function errStatus(e: unknown): number | undefined {
  if (typeof e === "object" && e !== null && "status" in e) {
    const s = (e as { status: unknown }).status;
    if (typeof s === "number") return s;
  }
  return undefined;
}

export class ArtifactsStore implements RepoStore {
  private readonly namespace: string;
  private readonly fetchImpl: typeof fetch;
  private readonly metaCache = new Map<string, RepoMeta>();
  private readonly remoteCache = new Map<string, string>();

  constructor(
    private accountId: string,
    private apiToken: string,
    opts: ArtifactsStoreOptions = {},
  ) {
    if (!accountId || !apiToken)
      throw new Error(
        "ArtifactsStore needs ARTIFACTS_ACCOUNT_ID and ARTIFACTS_API_TOKEN",
      );
    this.namespace = opts.namespace || DEFAULT_NAMESPACE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  // ---- naming -----------------------------------------------------------

  private mainRepoName(repo: string): string {
    return sanitizeRepoName(repo);
  }

  /** AgentGit (repo, branch) -> Artifacts repo name. */
  private artifactsRepoName(repo: string, branch: string): string {
    const main = this.mainRepoName(repo);
    return branch === MAIN_GIT_BRANCH ? main : `${main}--${sanitizeRepoName(branch)}`;
  }

  // ---- REST control plane ------------------------------------------------

  private acctBase(): string {
    return `${API_BASE}/accounts/${this.accountId}/artifacts`;
  }

  private nsBase(): string {
    return `${this.acctBase()}/namespaces/${this.namespace}`;
  }

  /**
   * One REST call against the Artifacts control plane.
   * Unpacks the Cloudflare v4 envelope; throws (with .status) on errors.
   */
  private async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.acctBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: V4Envelope<T> | null = null;
    try {
      json = text ? (JSON.parse(text) as V4Envelope<T>) : null;
    } catch {
      json = null;
    }
    if (json && json.success === false) {
      const first = json.errors?.[0];
      const err = new Error(
        `Artifacts API ${method} ${path}: ${first?.message ?? "unknown error"} (code ${first?.code ?? "?"})`,
      ) as Error & { status?: number; apiCode?: number };
      err.status = res.status;
      err.apiCode = first?.code;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(
        `Artifacts API ${method} ${path}: HTTP ${res.status}`,
      ) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return (json?.result ?? null) as T;
  }

  private async ensureNamespace(): Promise<void> {
    try {
      await this.rest(`GET`, `/namespaces/${this.namespace}`);
      return;
    } catch (e) {
      if (errStatus(e) !== 404) throw e;
    }
    try {
      await this.rest(`POST`, `/namespaces`, { namespace: this.namespace });
    } catch (e) {
      // Tolerate already-exists races: 409 or an "exists" message.
      const msg = e instanceof Error ? e.message : "";
      if (errStatus(e) === 409 || /already exists|exists/i.test(msg)) return;
      throw e;
    }
  }

  private async createRepoRecord(
    name: string,
    description: string,
  ): Promise<{ remote: string; token: string }> {
    // DELETE returns 202 (async); a create raced against it can 409 — retry.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.rest<{ remote: string; token: string }>(
          "POST",
          `/namespaces/${this.namespace}/repos`,
          { name, default_branch: MAIN_GIT_BRANCH, description },
        );
      } catch (e) {
        lastErr = e;
        if (errStatus(e) === 409 && attempt < 4) {
          await sleep(1500);
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  private async getRepoRecord(name: string): Promise<{ remote: string } | null> {
    try {
      return await this.rest<{ remote: string }>(
        "GET",
        `/namespaces/${this.namespace}/repos/${name}`,
      );
    } catch (e) {
      if (errStatus(e) === 404) return null;
      throw e;
    }
  }

  private async deleteRepoRecord(name: string): Promise<void> {
    try {
      await this.rest("DELETE", `/namespaces/${this.namespace}/repos/${name}`);
    } catch (e) {
      if (errStatus(e) === 404) return;
      throw e;
    }
  }

  private async forkRepoRecord(
    src: string,
    dst: string,
  ): Promise<{ remote: string; token: string }> {
    // A repo that is still forking/importing can 409 — retry briefly.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await this.rest<{ remote: string; token: string }>(
          "POST",
          `/namespaces/${this.namespace}/repos/${src}/fork`,
          { name: dst, default_branch_only: false },
        );
      } catch (e) {
        lastErr = e;
        if (errStatus(e) === 409 && attempt < 3) {
          await sleep(2000);
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  private async listRepoRecords(): Promise<{ name: string }[]> {
    const result = await this.rest<{ name: string }[] | null>(
      "GET",
      `/namespaces/${this.namespace}/repos?limit=200`,
    );
    return result ?? [];
  }

  private async mintWriteToken(repoName: string): Promise<string> {
    const result = await this.rest<{ plaintext: string }>(
      "POST",
      `/namespaces/${this.namespace}/tokens`,
      { repo: repoName, scope: "write", ttl: 3600 },
    );
    return result.plaintext;
  }

  /** Raw file bytes at a ref; null when missing. Uses the documented
   *  GET .../repos/:name/file?ref=&path= route (octet-stream on success). */
  private async readFileBytes(
    repoName: string,
    ref: string,
    path: string,
  ): Promise<Uint8Array | null> {
    const url =
      `${this.nsBase()}/repos/${repoName}/file?` +
      new URLSearchParams({ ref, path }).toString();
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.apiToken}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as {
          success?: boolean;
          errors?: { message?: string }[];
        };
        if (j && j.success === false) msg = j.errors?.[0]?.message ?? msg;
      } catch {
        /* ignore */
      }
      throw new Error(`Artifacts API read file ${path}@${ref} in ${repoName}: ${msg}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  // ---- metadata sidecar ---------------------------------------------------

  private async readMetaRecord(rname: string): Promise<RepoMeta | null> {
    const cached = this.metaCache.get(rname);
    if (cached) return cached;
    const bytes = await this.readFileBytes(rname, MAIN_GIT_BRANCH, META_PATH);
    if (!bytes) return null;
    try {
      const meta = JSON.parse(td.decode(bytes)) as RepoMeta;
      if (!meta || meta.version !== 1 || !meta.seed || !Array.isArray(meta.commits))
        return null;
      this.metaCache.set(rname, meta);
      return meta;
    } catch {
      return null;
    }
  }

  private async remoteFor(rname: string): Promise<string> {
    const cached = this.remoteCache.get(rname);
    if (cached) return cached;
    const rec = await this.getRepoRecord(rname);
    if (!rec) throw new Error(`ArtifactsStore: repo "${rname}" does not exist`);
    this.remoteCache.set(rname, rec.remote);
    return rec.remote;
  }

  /**
   * Push one git commit whose tree is exactly `treeFiles`.
   * The server's own old-sha check is the concurrency control: a lost race
   * comes back `ng` from receive-pack and surfaces as an error (retry the op).
   */
  private async pushTree(
    remote: string,
    repoToken: string,
    treeFiles: Record<string, string>,
    agent: string,
    message: string,
  ): Promise<string> {
    const { objects, rootSha } = await buildGitTrees(treeFiles);
    const { refs } = await discoverRefs(remote, repoToken, this.fetchImpl);
    const oldSha = refs.get(`refs/heads/${MAIN_GIT_BRANCH}`) ?? ZERO_SHA;
    const commitRaw = buildGitCommit(
      rootSha,
      oldSha === ZERO_SHA ? null : oldSha,
      agent,
      Date.now(),
      message,
    );
    const sha = await sha1Hex(commitRaw);
    const pack = await buildPack([{ typeNum: 1, raw: commitRaw, sha }, ...objects]);
    await gitPush({
      remote,
      repoToken,
      ref: `refs/heads/${MAIN_GIT_BRANCH}`,
      oldSha,
      newSha: sha,
      pack,
      fetchImpl: this.fetchImpl,
    });
    return sha;
  }

  // ---- RepoStore ----------------------------------------------------------

  async initRepo(repo: string, files: Record<string, string>): Promise<void> {
    await this.ensureNamespace();
    const main = this.mainRepoName(repo);
    // Wipe existing state (main + any branch forks), then create fresh.
    const existing = await this.listRepoRecords();
    for (const r of existing) {
      if (r.name === main || r.name.startsWith(main + "--"))
        await this.deleteRepoRecord(r.name);
    }
    this.metaCache.clear();
    this.remoteCache.clear();
    const { remote, token } = await this.createRepoRecord(
      main,
      `AgentGit repo "${repo}"`,
    );
    const meta: RepoMeta = {
      version: 1,
      repo,
      branch: MAIN_GIT_BRANCH,
      forkedFrom: null,
      seed: { ...files },
      commits: [],
    };
    const treeFiles: Record<string, string> = {
      ...files,
      [META_PATH]: JSON.stringify(meta),
    };
    await this.pushTree(remote, token, treeFiles, "agentgit", "seed");
    this.metaCache.set(main, meta);
    this.remoteCache.set(main, remote);
  }

  async repoExists(repo: string): Promise<boolean> {
    return (await this.getRepoRecord(this.mainRepoName(repo))) !== null;
  }

  async createBranch(repo: string, branch: string, fromBranch = "main"): Promise<void> {
    const src = this.artifactsRepoName(repo, fromBranch);
    const dst = this.artifactsRepoName(repo, branch);
    if (dst === src) return; // "main" already exists via initRepo
    if (await this.getRepoRecord(dst)) return; // idempotent, like MemoryStore
    const srcRec = await this.getRepoRecord(src);
    if (!srcRec)
      throw new Error(`ArtifactsStore: source branch "${fromBranch}" does not exist`);
    const srcMeta = await this.readMetaRecord(src);
    if (!srcMeta)
      throw new Error(
        `ArtifactsStore: source branch "${fromBranch}" is not initialized — call initRepo first`,
      );
    const { remote, token } = await this.forkRepoRecord(src, dst);
    const last = srcMeta.commits[srcMeta.commits.length - 1] ?? null;
    const newMeta: RepoMeta = { ...srcMeta, branch, forkedFrom: last ? last.sha : null };
    // Branchpoint commit: same files, corrected metadata (exact branch name +
    // fork point). Not an AgentGit commit — invisible to listCommits/getHead.
    const baseFiles = replayFiles(srcMeta.seed, srcMeta.commits);
    const treeFiles: Record<string, string> = {
      ...baseFiles,
      [META_PATH]: JSON.stringify(newMeta),
    };
    await this.pushTree(
      remote,
      token,
      treeFiles,
      "agentgit",
      `agentgit: create branch '${branch}'`,
    );
    this.metaCache.set(dst, newMeta);
    this.remoteCache.set(dst, remote);
  }

  private async allMetas(repo: string): Promise<RepoMeta[]> {
    const main = this.mainRepoName(repo);
    const records = await this.listRepoRecords();
    const out: RepoMeta[] = [];
    for (const r of records) {
      if (r.name !== main && !r.name.startsWith(main + "--")) continue;
      const meta = await this.readMetaRecord(r.name);
      if (meta) out.push(meta);
    }
    return out;
  }

  async listBranches(repo: string): Promise<BranchInfo[]> {
    const out: BranchInfo[] = [];
    for (const meta of await this.allMetas(repo)) {
      const last = meta.commits[meta.commits.length - 1] ?? null;
      out.push({
        name: meta.branch,
        head: last ? last.sha : null,
        forkedFrom: meta.forkedFrom,
      });
    }
    out.sort((a, b) =>
      a.name === MAIN_GIT_BRANCH ? -1 : b.name === MAIN_GIT_BRANCH ? 1 : a.name.localeCompare(b.name),
    );
    return out;
  }

  async commit(repo: string, branch: string, input: CommitInput): Promise<Commit> {
    const rname = this.artifactsRepoName(repo, branch);
    const remote = await this.remoteFor(rname);
    const meta = await this.readMetaRecord(rname);
    if (!meta)
      throw new Error(
        `ArtifactsStore: branch "${branch}" is not initialized — call initRepo first`,
      );
    const token = await this.mintWriteToken(rname);
    const parentEntry = meta.commits[meta.commits.length - 1] ?? null;
    const createdAt = Date.now();

    // 1. Content commit — tree carries the still-current metadata.
    const baseFiles = replayFiles(meta.seed, meta.commits);
    const newFiles: Record<string, string> = { ...baseFiles };
    for (const ch of input.changes) {
      if (!ch.path.startsWith(".agentgit/")) newFiles[ch.path] = ch.content;
    }
    const contentSha = await this.pushTree(
      remote,
      token,
      { ...newFiles, [META_PATH]: JSON.stringify(meta) },
      input.agent,
      input.message,
    );

    // 2. Metadata-sync commit — records the new entry (now that its sha is
    //    known). Invisible at the RepoStore layer; keeps the repo
    //    self-describing across isolates.
    const entry: MetaCommitEntry = {
      sha: contentSha,
      parent: parentEntry ? parentEntry.sha : null,
      agent: input.agent,
      message: input.message,
      changes: input.changes.filter((c) => !c.path.startsWith(".agentgit/")),
      createdAt,
    };
    const newMeta: RepoMeta = { ...meta, commits: [...meta.commits, entry] };
    await this.pushTree(
      remote,
      token,
      { ...newFiles, [META_PATH]: JSON.stringify(newMeta) },
      "agentgit",
      META_SYNC_MESSAGE,
    );
    this.metaCache.set(rname, newMeta);

    return { ...input, id: contentSha, parent: entry.parent, createdAt };
  }

  async getHead(repo: string, branch: string): Promise<Commit | null> {
    const meta = await this.readMetaRecord(this.artifactsRepoName(repo, branch));
    if (!meta) return null;
    const last = meta.commits[meta.commits.length - 1];
    if (!last) return null;
    return {
      agent: last.agent,
      message: last.message,
      changes: last.changes,
      id: last.sha,
      parent: last.parent,
      createdAt: last.createdAt,
    };
  }

  async getTree(repo: string, commitId: string | null): Promise<Record<string, string>> {
    if (commitId === null) {
      const meta = await this.readMetaRecord(this.mainRepoName(repo));
      if (!meta)
        throw new Error(`ArtifactsStore: repo "${repo}" is not initialized`);
      const tree = { ...meta.seed };
      for (const k of Object.keys(tree)) if (k.startsWith(".agentgit/")) delete tree[k];
      return tree;
    }
    for (const meta of await this.allMetas(repo)) {
      if (meta.commits.some((c) => c.sha === commitId))
        return replayFiles(meta.seed, meta.commits, commitId);
    }
    throw new Error(`ArtifactsStore: unknown commit ${commitId} in repo "${repo}"`);
  }

  async listCommits(repo: string, branch: string): Promise<Commit[]> {
    const meta = await this.readMetaRecord(this.artifactsRepoName(repo, branch));
    if (!meta) return [];
    return [...meta.commits].reverse().map((c) => ({
      agent: c.agent,
      message: c.message,
      changes: c.changes,
      id: c.sha,
      parent: c.parent,
      createdAt: c.createdAt,
    }));
  }
}
