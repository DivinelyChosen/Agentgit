/**
 * Unit tests for the real ArtifactsStore (src/store.ts).
 *
 * Run:  npx tsc --outDir /tmp/agent-git-dist && node test/artifacts.test.mjs
 * (or:   npm test)
 *
 * No network, no credentials, no AI calls. The Cloudflare Artifacts API is
 * replaced by a mocked fetch; git object encoding is verified against SHAs
 * produced by real git (2.43.0, `git hash-object` / `git mktree`).
 */
import {
  ArtifactsStore,
  ZERO_SHA,
  sha1Hex,
  encodeGitObject,
  buildGitTrees,
  buildGitCommit,
  buildPack,
  parseAdvertisedRefs,
  gitPush,
} from "/tmp/agent-git-dist/store.js";

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
async function assertThrows(fn, name) {
  try {
    await fn();
    fail++;
    console.log("  FAIL (no throw):", name);
  } catch {
    pass++;
    console.log("  ok:", name);
  }
}
const pkt = (s) => {
  const n = s.length + 4;
  return n.toString(16).padStart(4, "0") + s;
};

// ---------------------------------------------------------------- git objects
console.log("unit: git object encoding (verified against real git)");

{
  const empty = encodeGitObject("blob", new Uint8Array(0));
  assert(
    (await sha1Hex(empty)) === "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    "empty blob sha matches git",
  );
  const hello = encodeGitObject("blob", new TextEncoder().encode("hello\n"));
  assert(
    (await sha1Hex(hello)) === "ce013625030ba8dba906f756967f9e9ca394464a",
    '"hello\\n" blob sha matches git hash-object',
  );
  const { rootSha: emptyTree } = await buildGitTrees({});
  assert(
    emptyTree === "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    "empty tree sha matches git",
  );
}

{
  const { rootSha, objects } = await buildGitTrees({
    "a.txt": "hello\n",
    "b.txt": "world\n",
  });
  assert(rootSha === "18eb80fbbbf9160491c007668d5298f1e86cd40a", "flat tree sha matches git mktree");
  assert(objects.length === 3, "flat tree yields 2 blobs + 1 tree object");
  const commitRaw = buildGitCommit(rootSha, null, "t", 0, "test");
  assert(
    (await sha1Hex(commitRaw)) === "d0ebccecc15d5376100bd2f4ea8e1f7160c9bd6f",
    "commit sha matches git commit-tree output",
  );
}

{
  const { rootSha } = await buildGitTrees({ "sub/a.txt": "x\n", "top.txt": "y\n" });
  assert(
    rootSha === "f9052c2e46a8bffa998ad12a955859f893d1edcf",
    "nested tree sha matches git mktree (dir sorting correct)",
  );
}

{
  const commitRaw = buildGitCommit(
    "18eb80fbbbf9160491c007668d5298f1e86cd40a",
    null,
    "t",
    0,
    "test",
  );
  const pack = await buildPack([{ typeNum: 1, raw: commitRaw, sha: "x" }]);
  const dv = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  assert(
    pack[0] === 0x50 && pack[1] === 0x41 && pack[2] === 0x43 && pack[3] === 0x4b,
    'pack starts with "PACK" magic',
  );
  assert(dv.getUint32(4) === 2, "pack version is 2");
  assert(dv.getUint32(8) === 1, "pack object count correct");
  const body = pack.slice(0, pack.length - 20);
  const trailer = pack.slice(pack.length - 20);
  const trailerHex = [...trailer].map((b) => b.toString(16).padStart(2, "0")).join("");
  assert((await sha1Hex(body)) === trailerHex, "pack trailer is sha1 of pack body");
}

{
  const OLD = "a".repeat(40);
  const discovery =
    pkt("# service=git-receive-pack\n") +
    "0000" +
    pkt(`${OLD} refs/heads/main\0report-status delete-refs\n`) +
    "0000";
  const { refs, capabilities } = parseAdvertisedRefs(discovery);
  assert(refs.get("refs/heads/main") === OLD, "ref discovery parses advertised sha");
  assert(capabilities.has("report-status"), "ref discovery parses capabilities");
}

// ---------------------------------------------------------------- git push
console.log("unit: git push protocol (mocked fetch)");

{
  const OLD = "a".repeat(40);
  const NEW = "b".repeat(40);
  const REMOTE = "https://acct123.artifacts.cloudflare.net/git/testns/demo.git";
  const TOKEN = "art_v1_abc123?expires=9999999999";
  const calls = [];
  const discovery =
    pkt("# service=git-receive-pack\n") + "0000" + pkt(`${OLD} refs/heads/main\0report-status\n`) + "0000";
  const mockFetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/info/refs"))
      return new Response(discovery, { status: 200 });
    if (String(url).includes("/git-receive-pack"))
      return new Response(pkt("unpack ok\n") + pkt("ok refs/heads/main\n") + "0000", {
        status: 200,
      });
    throw new Error("unexpected URL " + url);
  };

  await gitPush({
    remote: REMOTE,
    repoToken: TOKEN,
    ref: "refs/heads/main",
    oldSha: OLD,
    newSha: NEW,
    pack: new Uint8Array([1, 2, 3]),
    fetchImpl: mockFetch,
  });

  assert(
    calls[0].url === `${REMOTE}/info/refs?service=git-receive-pack`,
    "push starts with ref discovery",
  );
  assert(
    calls[0].init.headers.Authorization === "Basic " + btoa(`x:${TOKEN}`),
    "git routes use Basic x:<repo-token> auth (token kept whole, incl. ?expires=)",
  );
  assert(
    calls[1].url === `${REMOTE}/git-receive-pack` &&
      calls[1].init.method === "POST" &&
      calls[1].init.headers["Content-Type"] === "application/x-git-receive-pack-request",
    "push POSTs to git-receive-pack with correct content type",
  );
  const bodyText = new TextDecoder().decode(calls[1].init.body.slice(0, 140));
  assert(
    bodyText.includes(`${OLD} ${NEW} refs/heads/main`) && bodyText.includes("report-status"),
    "push command line carries old/new shas, ref, and report-status",
  );
  assert(
    calls[1].init.body[calls[1].init.body.length - 1] === 3,
    "pack bytes follow the pkt-line command in the request body",
  );

  // Rejection path: server says ng -> gitPush throws.
  const mockNg = async (url, init = {}) => {
    if (String(url).includes("/info/refs")) return new Response(discovery, { status: 200 });
    return new Response(pkt("unpack ok\n") + pkt("ng refs/heads/main pre-receive hook declined\n") + "0000", {
      status: 200,
    });
  };
  await assertThrows(
    () =>
      gitPush({
        remote: REMOTE,
        repoToken: TOKEN,
        ref: "refs/heads/main",
        oldSha: OLD,
        newSha: NEW,
        pack: new Uint8Array([1]),
        fetchImpl: mockNg,
      }),
    "push rejection (ng) surfaces as a thrown error",
  );
}

// ---------------------------------------------------------------- REST client
console.log("unit: Artifacts REST client (mocked fetch)");

{
  const calls = [];
  const mockFetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/repos/demo"))
      return Response.json({
        result: { name: "demo", remote: "https://acct123.artifacts.cloudflare.net/git/testns/demo.git" },
        success: true,
        errors: [],
        messages: [],
      });
    if (String(url).endsWith("/repos/nope"))
      return new Response(
        JSON.stringify({
          result: null,
          success: false,
          errors: [{ code: 10200, message: "Repo not found" }],
          messages: [],
        }),
        { status: 404 },
      );
    throw new Error("unexpected URL " + url);
  };
  const store = new ArtifactsStore("ACCT123", "TOKEN456", {
    namespace: "testns",
    fetchImpl: mockFetch,
  });
  assert((await store.repoExists("demo")) === true, "repoExists true on 200 envelope");
  assert((await store.repoExists("nope")) === false, "repoExists false on 404 envelope");
  assert(
    calls[0].url ===
      "https://api.cloudflare.com/client/v4/accounts/ACCT123/artifacts/namespaces/testns/repos/demo",
    "REST calls hit the documented account/namespace base path",
  );
  assert(
    calls[0].init.headers.Authorization === "Bearer TOKEN456",
    "REST control plane uses Bearer <api-token> auth",
  );
  assert(calls[0].init.method === "GET", "repoExists issues GET");

  await assertThrows(
    () => new ArtifactsStore("", ""),
    "constructor refuses empty account id / token",
  );
  assert(ZERO_SHA === "0".repeat(40), "ZERO_SHA is 40 zeros (empty-ref push)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
