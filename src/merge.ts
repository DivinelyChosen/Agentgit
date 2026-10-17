/**
 * Line-based 3-way merge for the AgentGit coordinator.
 *
 * Pure functions, no I/O — fully unit-testable (see test/fixture.mjs).
 * Conservative by design: overlapping edits that differ are flagged as
 * conflicts rather than guessed at.
 */

import type { RepoStore } from "./store";

export interface Hunk {
  baseStart: number; // index into base lines, inclusive
  baseEnd: number; // exclusive
  newLines: string[];
}

export interface LineConflict {
  baseStart: number;
  baseEnd: number;
  oursLines: string[];
  theirsLines: string[];
}

export function splitLines(s: string): string[] {
  return s === "" ? [] : s.split("\n");
}

/** LCS-based line diff: base -> next, as hunks over base coordinates. */
export function diffLines(base: string[], next: string[]): Hunk[] {
  const n = base.length;
  const m = next.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        base[i] === next[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  type Op = { t: "eq" } | { t: "del" } | { t: "ins"; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === next[j]) {
      ops.push({ t: "eq" });
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push({ t: "ins", line: next[j] });
      j++;
    } else {
      ops.push({ t: "del" });
      i++;
    }
  }

  const hunks: Hunk[] = [];
  let bi = 0;
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === "eq") {
      bi++;
      k++;
      continue;
    }
    const bs = bi;
    const newLines: string[] = [];
    while (k < ops.length && ops[k].t !== "eq") {
      const op = ops[k];
      if (op.t === "ins") newLines.push(op.line as string);
      else bi++;
      k++;
    }
    hunks.push({ baseStart: bs, baseEnd: bi, newLines });
  }
  return hunks;
}

/**
 * 3-way line merge. Non-overlapping edits from both sides apply cleanly;
 * identical overlapping edits apply once; differing overlaps become conflicts
 * with classic <<<<<<< / ======= / >>>>>>> markers.
 */
export function mergeLines(
  base: string[],
  ours: string[],
  theirs: string[],
  theirsLabel = "branch",
): { lines: string[]; conflicts: LineConflict[] } {
  const oh = diffLines(base, ours);
  const th = diffLines(base, theirs);
  const out: string[] = [];
  const conflicts: LineConflict[] = [];
  let pos = 0;
  let a = 0;
  let b = 0;

  // Two pure insertions at the same base position overlap (both sides
  // added different text in the same spot); an insertion exactly at the
  // boundary of a changed region does not.
  const overlaps = (x: Hunk, y: Hunk) => {
    if (x.baseStart === x.baseEnd && y.baseStart === y.baseEnd) {
      return x.baseStart === y.baseStart;
    }
    return x.baseStart < y.baseEnd && y.baseStart < x.baseEnd;
  };
  const same = (x: Hunk, y: Hunk) =>
    x.baseStart === y.baseStart &&
    x.baseEnd === y.baseEnd &&
    x.newLines.length === y.newLines.length &&
    x.newLines.every((l, idx) => l === y.newLines[idx]);

  while (a < oh.length || b < th.length) {
    const o = a < oh.length ? oh[a] : null;
    const t = b < th.length ? th[b] : null;

    if (o && t && overlaps(o, t)) {
      if (same(o, t)) {
        out.push(...base.slice(pos, o.baseStart), ...o.newLines);
        pos = o.baseEnd;
        a++;
        b++;
        continue;
      }
      // Conflict: union span, absorbing any further overlapping hunks.
      let s = Math.min(o.baseStart, t.baseStart);
      let e = Math.max(o.baseEnd, t.baseEnd);
      const oH: Hunk[] = [];
      const tH: Hunk[] = [];
      const spanOverlaps = (h: Hunk) => {
        if (h.baseStart === h.baseEnd) return h.baseStart >= s && h.baseStart <= e;
        return h.baseStart < e && h.baseEnd > s;
      };
      let growing = true;
      while (growing) {
        growing = false;
        while (a < oh.length && spanOverlaps(oh[a])) {
          const h = oh[a++];
          oH.push(h);
          s = Math.min(s, h.baseStart);
          e = Math.max(e, h.baseEnd);
          growing = true;
        }
        while (b < th.length && spanOverlaps(th[b])) {
          const h = th[b++];
          tH.push(h);
          s = Math.min(s, h.baseStart);
          e = Math.max(e, h.baseEnd);
          growing = true;
        }
      }
      out.push(...base.slice(pos, s));
      out.push("<<<<<<< main");
      for (const h of oH) out.push(...h.newLines);
      out.push("=======");
      for (const h of tH) out.push(...h.newLines);
      out.push(`>>>>>>> ${theirsLabel}`);
      conflicts.push({
        baseStart: s,
        baseEnd: e,
        oursLines: oH.flatMap((h) => h.newLines),
        theirsLines: tH.flatMap((h) => h.newLines),
      });
      pos = e;
      continue;
    }

    if (o && (!t || o.baseStart <= t.baseStart)) {
      out.push(...base.slice(pos, o.baseStart), ...o.newLines);
      pos = o.baseEnd;
      a++;
    } else if (t) {
      out.push(...base.slice(pos, t.baseStart), ...t.newLines);
      pos = t.baseEnd;
      b++;
    }
  }
  out.push(...base.slice(pos));
  return { lines: out, conflicts };
}

// ---------------------------------------------------------------------------
// Repo-level coordination: merge every branch into main, one by one.
// ---------------------------------------------------------------------------

export interface MergeConflict {
  path: string;
  branch: string;
  oursText: string; // main's version
  theirsText: string; // branch's version
  markerText: string; // merged output with conflict markers
}

export interface MergeReport {
  repo: string;
  mergedBranches: string[];
  mergeCommitIds: string[];
  skippedBranches: string[];
  conflicts: MergeConflict[];
  filesChanged: string[];
}

/**
 * Coordinator: for each non-main branch, 3-way merge its head against main
 * using the branch's fork point as merge-base. Clean branches get their own
 * merge commit on main; conflicting branches are reported with both versions
 * and main is left untouched by them.
 */
export async function mergeRepoBranches(
  store: RepoStore,
  repo: string,
  mainName = "main",
): Promise<MergeReport> {
  const branches = (await store.listBranches(repo)).filter((b) => b.name !== mainName);
  const mainHead = await store.getHead(repo, mainName);
  let oursTree = await store.getTree(repo, mainHead ? mainHead.id : null);

  const report: MergeReport = {
    repo,
    mergedBranches: [],
    mergeCommitIds: [],
    skippedBranches: [],
    conflicts: [],
    filesChanged: [],
  };

  for (const b of branches) {
    const head = await store.getHead(repo, b.name);
    if (!head) {
      report.skippedBranches.push(b.name);
      continue;
    }
    const baseTree = await store.getTree(repo, b.forkedFrom);
    const branchTree = await store.getTree(repo, head.id);
    const paths = new Set([
      ...Object.keys(baseTree),
      ...Object.keys(oursTree),
      ...Object.keys(branchTree),
    ]);

    const nextTree = { ...oursTree };
    const touched: string[] = [];
    const branchConflicts: MergeConflict[] = [];

    for (const path of paths) {
      const base = baseTree[path] ?? "";
      const ours = oursTree[path] ?? "";
      const theirs = branchTree[path] ?? "";
      if (theirs === base || ours === theirs) continue; // branch didn't change it
      if (ours === base) {
        nextTree[path] = theirs;
        touched.push(path);
        continue;
      }
      const m = mergeLines(splitLines(base), splitLines(ours), splitLines(theirs), b.name);
      if (m.conflicts.length === 0) {
        nextTree[path] = m.lines.join("\n");
        touched.push(path);
      } else {
        branchConflicts.push({
          path,
          branch: b.name,
          oursText: ours,
          theirsText: theirs,
          markerText: m.lines.join("\n"),
        });
      }
    }

    if (branchConflicts.length === 0) {
      const mc = await store.commit(repo, mainName, {
        agent: "coordinator",
        message: `Merge branch '${b.name}' (auto: ${touched.length} file${touched.length === 1 ? "" : "s"})`,
        changes: touched.map((path) => ({ path, content: nextTree[path] })),
      });
      report.mergeCommitIds.push(mc.id);
      report.mergedBranches.push(b.name);
      oursTree = nextTree;
      for (const p of touched) if (!report.filesChanged.includes(p)) report.filesChanged.push(p);
    } else {
      report.conflicts.push(...branchConflicts);
    }
  }

  return report;
}
