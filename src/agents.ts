/**
 * Agent roles for the AgentGit demo. Each agent does exactly ONE job —
 * no agent carries documents, plans, or other agents' work.
 *
 * The model-facing contract is strict JSON so diffs stay machine-readable:
 *   {"files": [{"path": "relative/path.ext", "content": "full new content"}]}
 */

export interface AgentDef {
  id: string;
  title: string;
  job: string;
  systemPrompt: string;
}

export const AGENTS: Record<string, AgentDef> = {
  frontend: {
    id: "frontend",
    title: "Frontend Agent",
    job: "implement user-interface changes",
    systemPrompt: [
      "You are the Frontend Agent. You do ONE job: implement user-interface changes.",
      "You write components, markup, styles, and client-side logic. You never touch",
      "API routes, server code, or tests. If a task needs those, say so in one line",
      "and change only the UI files.",
      "Output ONLY the JSON object described by the user message — no prose,",
      "no markdown fences, no explanations.",
    ].join(" "),
  },

  api: {
    id: "api",
    title: "API Agent",
    job: "implement server-side endpoints and data logic",
    systemPrompt: [
      "You are the API Agent. You do ONE job: implement server-side endpoints",
      "and data logic. You write route handlers, request parsing, and response",
      "shapes. You never touch UI components, styles, documentation, or tests.",
      "Output ONLY the JSON object described by the user message — no prose,",
      "no markdown fences, no explanations.",
    ].join(" "),
  },

  docs: {
    id: "docs",
    title: "Docs Agent",
    job: "write and update documentation",
    systemPrompt: [
      "You are the Docs Agent. You do ONE job: write and update documentation.",
      "You write READMEs, guides, and API references that describe what the code",
      "does. You never change code files — only markdown and text docs.",
      "Output ONLY the JSON object described by the user message — no prose,",
      "no markdown fences, no explanations.",
    ].join(" "),
  },

  tests: {
    id: "tests",
    title: "Test Agent",
    job: "write tests for existing code",
    systemPrompt: [
      "You are the Test Agent. You do ONE job: write tests for existing code.",
      "You read the implementation files and produce test files that verify their",
      "behavior. You never change implementation files — only add test files.",
      "Output ONLY the JSON object described by the user message — no prose,",
      "no markdown fences, no explanations.",
    ].join(" "),
  },

  security: {
    id: "security",
    title: "Security Agent",
    job: "audit code for vulnerabilities and harden it",
    systemPrompt: [
      "You are the Security Agent. You do ONE job: audit code for vulnerabilities",
      "and harden it. You fix injection risks, exposed secrets, and unsafe",
      "patterns. You never add features, change UI, or write docs — only make",
      "the existing code safer.",
      "Output ONLY the JSON object described by the user message — no prose,",
      "no markdown fences, no explanations.",
    ].join(" "),
  },
};

/** Build the user message: current repo tree + the task + the JSON contract. */
export function buildTaskPrompt(
  agent: AgentDef,
  tree: Record<string, string>,
  task: string,
): string {
  const files = Object.entries(tree)
    .map(([p, c]) => `--- path: ${p}\n${c}`)
    .join("\n");
  return [
    `REPO FILES (current state of main):`,
    files || "(empty repo)",
    ``,
    `TASK: ${task}`,
    ``,
    `YOUR JOB: ${agent.job}. Do only that job.`,
    ``,
    `OUTPUT CONTRACT — reply with ONLY this JSON object:`,
    `{"files": [{"path": "relative/path.ext", "content": "full new file content"}]}`,
    `Rules: include the FULL new content of every file you change or create.`,
    `Touch only the files your job needs. Paths are relative, no leading slash.`,
  ].join("\n");
}

export interface ParsedChanges {
  files: { path: string; content: string }[];
  note?: string;
}

/** Defensive parse of model output into file changes. */
export function parseFileChanges(text: string): ParsedChanges {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  // tolerate leading/trailing prose: grab the outermost {...}
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    const j = JSON.parse(t) as { files?: unknown };
    const raw = Array.isArray(j.files) ? j.files : [];
    const files = (raw as unknown[])
      .filter(
        (f): f is { path: string; content: string } =>
          !!f &&
          typeof (f as { path?: unknown }).path === "string" &&
          typeof (f as { content?: unknown }).content === "string",
      )
      .map((f) => ({ path: f.path.replace(/^\/+/, ""), content: f.content }));
    if (files.length === 0) return { files, note: "model returned no file changes" };
    return { files };
  } catch {
    return { files: [], note: "model output was not valid JSON; nothing committed" };
  }
}
