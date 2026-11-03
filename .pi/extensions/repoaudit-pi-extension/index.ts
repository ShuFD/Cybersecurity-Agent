import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

const MAX_FILES = 10_000;
const MAX_FILE_BYTES = 512_000;
const MAX_SNIPPET = 8_000;
const MAX_AUDIT = 300;
const MAX_SNAPSHOTS = 8;

const languages = ["Cpp", "Java", "Python", "Go"] as const;
const scanTypes = ["metascan", "dfbscan"] as const;
const bugTypes = ["NPD", "MLK", "UAF"] as const;
const phases = ["initialized", "indexed", "candidates", "validated", "reported", "completed"] as const;
const findingStatuses = ["candidate", "confirmed", "rejected", "inconclusive"] as const;

type Language = (typeof languages)[number];
type ScanType = (typeof scanTypes)[number];
type BugType = (typeof bugTypes)[number];
type Phase = (typeof phases)[number];
type FindingStatus = (typeof findingStatuses)[number];

interface RepoAuditConfig {
  schemaVersion: 1;
  mode: "local-readonly";
  maxFiles: number;
  maxFileBytes: number;
  excludedDirectories: string[];
  requireHumanConfirmation: boolean;
}

const defaultConfig: RepoAuditConfig = {
  schemaVersion: 1,
  mode: "local-readonly",
  maxFiles: MAX_FILES,
  maxFileBytes: MAX_FILE_BYTES,
  excludedDirectories: [".git", ".github", ".vscode", ".idea", "build", "dist", "out", "bin", "target", "vendor", "pkg", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", "venv", "env", "obj", "Debug", "Release", "CMakeFiles"],
  requireHumanConfirmation: true,
};

interface FileMeta {
  path: string;
  relativePath: string;
  extension: string;
  bytes: number;
  lines: number;
  functions: string[];
  apiCalls: string[];
}

interface CandidatePath {
  candidateId: string;
  bugType: BugType;
  source: string;
  sink: string;
  steps: string[];
  files: string[];
  lineHints: number[];
  isReachable: boolean;
  explanation: string;
  evidence: string[];
  status: FindingStatus;
  createdAt: string;
  validatedAt?: string;
}

interface Finding {
  findingId: string;
  candidateId: string;
  bugType: BugType;
  language: Language;
  status: FindingStatus;
  title: string;
  file: string;
  line: number;
  functionName: string;
  description: string;
  evidence: string;
  explanation: string;
  humanConfirmed: boolean | null;
  createdAt: string;
}

interface AuditEvent {
  eventId: string;
  type: string;
  detail: string;
  at: string;
}

interface State {
  schemaVersion: 1;
  auditId: string;
  projectPath: string;
  projectName: string;
  language: Language;
  scanType: ScanType;
  bugType?: BugType;
  isReachable: boolean;
  modelName?: string;
  temperature: number;
  callDepth: number;
  maxSymbolicWorkers: number;
  maxNeuralWorkers: number;
  phase: Phase;
  version: number;
  files: Record<string, FileMeta>;
  candidates: Record<string, CandidatePath>;
  findings: Record<string, Finding>;
  snapshots: State[];
  audit: AuditEvent[];
}

const schema = Type.Object({
  action: StringEnum([
    "init", "status", "index", "list_files", "get_file", "plan", "record_candidate",
    "validate_candidate", "record_finding", "confirm_finding", "report", "finish", "rollback",
  ] as const),
  projectPath: Type.Optional(Type.String()),
  language: Type.Optional(StringEnum(languages)),
  scanType: Type.Optional(StringEnum(scanTypes)),
  bugType: Type.Optional(StringEnum(bugTypes)),
  isReachable: Type.Optional(Type.Boolean()),
  modelName: Type.Optional(Type.String()),
  temperature: Type.Optional(Type.Number()),
  callDepth: Type.Optional(Type.Number()),
  maxSymbolicWorkers: Type.Optional(Type.Number()),
  maxNeuralWorkers: Type.Optional(Type.Number()),
  path: Type.Optional(Type.String()),
  candidateId: Type.Optional(Type.String()),
  source: Type.Optional(Type.String()),
  sink: Type.Optional(Type.String()),
  steps: Type.Optional(Type.Array(Type.String())),
  files: Type.Optional(Type.Array(Type.String())),
  lineHints: Type.Optional(Type.Array(Type.Number())),
  reachable: Type.Optional(Type.Boolean()),
  explanation: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.Array(Type.String())),
  status: Type.Optional(StringEnum(findingStatuses)),
  findingId: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  line: Type.Optional(Type.Number()),
  functionName: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  humanConfirmed: Type.Optional(Type.Boolean()),
  format: Type.Optional(StringEnum(["markdown", "json"] as const)),
  snapshotVersion: Type.Optional(Type.Number()),
});

type Input = Static<typeof schema>;

const now = () => new Date().toISOString();
const makeId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const cleanList = (items: string[] | undefined) => [...new Set((items ?? []).map((item) => item.trim()).filter(Boolean))];
const clip = (value: string, max = MAX_SNIPPET) => value.length > max ? `${value.slice(0, max)}\n...[truncated]` : value;

function result(text: string, state?: State, isError = false) {
  return { content: [{ type: "text" as const, text }], details: state ? { state } : {}, isError };
}

function loadConfig(cwd: string): { config: RepoAuditConfig; path: string; warning?: string } {
  const candidates = [resolve(cwd, ".pi", "extensions", "repoaudit", "repoaudit.json"), resolve(cwd, ".pi", "repoaudit.json")];
  const path = candidates.find((item) => existsSync(item)) ?? candidates[0];
  if (!existsSync(path)) return { config: defaultConfig, path, warning: "repoaudit.json not found; using local-readonly defaults" };
  try {
    const source = JSON.parse(readFileSync(path, "utf8")) as Partial<RepoAuditConfig>;
    if (source.schemaVersion !== 1 || source.mode !== "local-readonly") throw new Error("schemaVersion or mode is invalid");
    const bounded = (name: string, value: unknown, min: number, max: number) => {
      const number = Number(value);
      if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be ${min}-${max}`);
      return number;
    };
    if (!Array.isArray(source.excludedDirectories) || !source.excludedDirectories.every((item) => typeof item === "string")) throw new Error("excludedDirectories must be a string array");
    return {
      path,
      config: {
        schemaVersion: 1,
        mode: "local-readonly",
        maxFiles: bounded("maxFiles", source.maxFiles, 1, MAX_FILES),
        maxFileBytes: bounded("maxFileBytes", source.maxFileBytes, 1024, MAX_FILE_BYTES),
        excludedDirectories: cleanList(source.excludedDirectories),
        requireHumanConfirmation: source.requireHumanConfirmation !== false,
      },
    };
  } catch (error) {
    return { config: defaultConfig, path, warning: `Invalid repoaudit.json; using local-readonly defaults: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function extensionsFor(language: Language) {
  if (language === "Cpp") return new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"]);
  if (language === "Java") return new Set([".java"]);
  if (language === "Python") return new Set([".py"]);
  return new Set([".go"]);
}

function isSupportedBug(language: Language, bugType: BugType) {
  return language === "Cpp" ? bugType === "NPD" || bugType === "MLK" || bugType === "UAF" : bugType === "NPD";
}

function collectFiles(root: string, language: Language, config: RepoAuditConfig): FileMeta[] {
  const suffixes = extensionsFor(language);
  const files: FileMeta[] = [];
  const visit = (directory: string) => {
    if (files.length >= config.maxFiles) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= config.maxFiles) break;
      if (entry.isDirectory()) {
        if (config.excludedDirectories.includes(entry.name) || entry.name.startsWith(".")) continue;
        visit(resolve(directory, entry.name));
        continue;
      }
      const fullPath = resolve(directory, entry.name);
      if (!suffixes.has(extname(entry.name).toLowerCase())) continue;
      let stat;
      try { stat = statSync(fullPath); } catch { continue; }
      if (stat.size > config.maxFileBytes) continue;
      let source = "";
      try { source = readFileSync(fullPath, "utf8"); } catch { continue; }
      const functions = extractFunctions(source, language);
      const apiCalls = [...source.matchAll(/\b(?:malloc|calloc|realloc|free|new|delete|open|close|strcpy|memcpy|exec|system|subprocess|os\.system|unsafe\.)\s*\(?/g)].map((match) => match[0].replace(/\s*\(?$/, ""));
      files.push({ path: fullPath, relativePath: relative(root, fullPath) || basename(fullPath), extension: extname(entry.name).toLowerCase(), bytes: stat.size, lines: source.split(/\r?\n/).length, functions, apiCalls: cleanList(apiCalls) });
    }
  };
  visit(root);
  return files;
}

function extractFunctions(source: string, language: Language) {
  const patterns = language === "Python"
    ? [/^\s*def\s+([A-Za-z_][\w]*)/gm, /^\s*async\s+def\s+([A-Za-z_][\w]*)/gm]
    : language === "Go"
      ? [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/gm]
      : [/^\s*(?:public|private|protected|static|virtual|inline|final|synchronized|const\s+)?[\w:<>,*&\[\]]+\s+([A-Za-z_][\w]*)\s*\([^;]*\)\s*[{]/gm];
  const names: string[] = [];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) if (match[1]) names.push(match[1]);
  return cleanList(names).slice(0, 200);
}

function pathWithin(root: string, requested: string) {
  const full = resolve(root, requested);
  const rel = relative(root, full);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)) ? full : undefined;
}

function validateInit(input: Input, ctxCwd: string, config: RepoAuditConfig): State | string {
  if (!input.projectPath?.trim()) return "projectPath is required";
  if (!input.language) return "language is required";
  if (!input.scanType) return "scanType is required";
  const projectPath = resolve(ctxCwd, input.projectPath.trim());
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) return `projectPath is not a directory: ${projectPath}`;
  if (input.scanType === "dfbscan") {
    if (!input.bugType) return "bugType is required for dfbscan";
    if (!isSupportedBug(input.language, input.bugType)) return `${input.bugType} is not supported for ${input.language}; RepoAudit currently supports NPD for Java/Python/Go and NPD/MLK/UAF for Cpp`;
  }
  const auditId = makeId("audit");
  const root = makeId("meta");
  return {
    schemaVersion: 1,
    auditId,
    projectPath,
    projectName: basename(projectPath),
    language: input.language,
    scanType: input.scanType,
    bugType: input.bugType,
    isReachable: input.isReachable ?? false,
    modelName: input.modelName?.trim() || undefined,
    temperature: input.temperature ?? 0.5,
    callDepth: input.callDepth ?? 3,
    maxSymbolicWorkers: input.maxSymbolicWorkers ?? 30,
    maxNeuralWorkers: input.maxNeuralWorkers ?? 1,
    phase: "initialized",
    files: {}, candidates: {}, findings: {}, snapshots: [],
    audit: [{ eventId: root, type: "init", detail: `Initialized ${input.scanType} for ${projectPath}`, at: now() }],
  };
}

export default function repoaudit(pi: ExtensionAPI) {
  let state: State | undefined;
  let config = defaultConfig;
  let configPath = ".pi/extensions/repoaudit/repoaudit.json";

  const persist = (next: State, detail: string) => {
    next.version += 1;
    next.audit = [...next.audit, { eventId: makeId("event"), type: "state_change", detail, at: now() }].slice(-MAX_AUDIT);
    pi.appendEntry("repoaudit-state-v1", clone(next));
    state = next;
  };

  const mutate = (detail: string, fn: (draft: State) => void) => {
    if (!state) throw new Error("No active RepoAudit session");
    const previous = clone(state);
    previous.snapshots = [];
    const draft = clone(state);
    draft.snapshots = [previous, ...state.snapshots].slice(0, MAX_SNAPSHOTS);
    fn(draft);
    persist(draft, detail);
    return draft;
  };

  pi.on("session_start", (_event, ctx) => {
    const loaded = loadConfig(ctx.cwd);
    config = loaded.config;
    configPath = loaded.path;
    if (loaded.warning && ctx.hasUI) ctx.ui.notify(loaded.warning, "warning");
    const entries = ctx.sessionManager.getEntries();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.type === "custom" && entry.customType === "repoaudit-reset") { state = undefined; break; }
      if (entry.type === "custom" && entry.customType === "repoaudit-state-v1" && entry.data) { state = clone(entry.data as State); break; }
    }
    if (state && ctx.hasUI) ctx.ui.setStatus("repoaudit", `${state.projectName} ${state.phase}`);
  });

  pi.registerTool({
    name: "repoAudit",
    label: "RepoAudit",
    description: "RepoAudit-inspired local repository auditing workflow. It manages MetaScan and DFBScan phases, language/bug-type support, syntactic memory, data-flow candidates, path validation, deduplicated findings, and reports. It only reads local files and does not invoke shell commands or external targets.",
    promptSnippet: "Audit a local repository with RepoAudit's MetaScan/DFBScan workflow and evidence-backed findings",
    promptGuidelines: [
      "Use repoAudit init with a local projectPath, language, and scanType before analysis.",
      "Use index for the MetaScan-style syntactic inventory before creating data-flow candidates.",
      "For dfbscan, record source/sink paths with record_candidate, then use validate_candidate with an explanation and evidence.",
      "Use external Pi read/grep tools or a research model for deeper analysis, but write their exact references into evidence fields.",
      "Never call a finding confirmed without a validated candidate and, when configured, human confirmation.",
      "RepoAudit is local-readonly: this tool never writes to the audited repository and never runs commands by itself.",
    ],
    parameters: schema,
    async execute(_toolCallId, input, signal, _onUpdate, ctx) {
      if (signal.aborted) return result("Cancelled", state, true);

      if (input.action === "init") {
        const initialized = validateInit(input, ctx.cwd, config);
        if (typeof initialized === "string") return result(initialized, undefined, true);
        state = initialized;
        persist(state, `Initialized ${state.auditId}`);
        pi.setSessionName(`RepoAudit: ${state.projectName}`);
        if (ctx.hasUI) ctx.ui.setStatus("repoaudit", `${state.projectName} initialized`);
        return result(`Initialized RepoAudit ${state.auditId} for ${state.projectName}. Use index before analysis.`, state);
      }
      if (!state) return result("No active RepoAudit session. Call init first.", undefined, true);

      if (input.action === "status") {
        return result(JSON.stringify({
          auditId: state.auditId, projectPath: state.projectPath, projectName: state.projectName, language: state.language, scanType: state.scanType, bugType: state.bugType,
          isReachable: state.isReachable, phase: state.phase, configPath, fileCount: Object.keys(state.files).length, candidateCount: Object.keys(state.candidates).length,
          findingCount: Object.keys(state.findings).length, findings: Object.values(state.findings).map(({ findingId, bugType, status, title, file, line, humanConfirmed }) => ({ findingId, bugType, status, title, file, line, humanConfirmed })),
        }, null, 2), state);
      }

      if (input.action === "index") {
        const files = collectFiles(state.projectPath, state.language, config);
        const next = mutate(`Indexed ${files.length} source file(s)`, (draft) => {
          draft.files = Object.fromEntries(files.map((file) => [file.relativePath, file]));
          draft.phase = "indexed";
        });
        return result(JSON.stringify({ phase: next.phase, fileCount: files.length, files: files.map(({ relativePath, bytes, lines, functions, apiCalls }) => ({ relativePath, bytes, lines, functions, apiCalls })) }, null, 2), next);
      }

      if (input.action === "list_files") {
        return result(JSON.stringify(Object.values(state.files), null, 2), state);
      }

      if (input.action === "get_file") {
        if (!input.path) return result("path is required", state, true);
        const safePath = pathWithin(state.projectPath, input.path);
        if (!safePath || !existsSync(safePath) || !statSync(safePath).isFile()) return result("path is outside the indexed project or is not a file", state, true);
        const source = readFileSync(safePath, "utf8");
        return result(clip(source, config.maxFileBytes), state);
      }

      if (input.action === "plan") {
        const next = mutate("Planned RepoAudit pipeline", (draft) => {
          draft.phase = draft.files && Object.keys(draft.files).length ? "candidates" : "initialized";
          draft.audit.push({ eventId: makeId("event"), type: "plan", detail: draft.scanType === "metascan" ? "MetaScan: syntax and call metadata inventory" : `DFBScan: ${draft.bugType} source/sink extraction, data-flow exploration, and path validation`, at: now() });
        });
        return result(JSON.stringify({ pipeline: state.scanType === "metascan" ? ["index", "inspect metadata", "report"] : ["index", "extract source/sink candidates", "validate paths", "record findings", "report"], language: state.language, bugType: state.bugType, workers: { symbolic: state.maxSymbolicWorkers, neural: state.maxNeuralWorkers }, callDepth: state.callDepth }, null, 2), next);
      }

      if (input.action === "record_candidate") {
        if (state.scanType !== "dfbscan") return result("record_candidate is only available for dfbscan", state, true);
        if (!input.source?.trim() || !input.sink?.trim() || !input.explanation?.trim()) return result("source, sink, and explanation are required", state, true);
        const candidateId = input.candidateId?.trim() || makeId("candidate");
        const files = cleanList(input.files);
        const next = mutate(`Recorded candidate ${candidateId}`, (draft) => {
          draft.candidates[candidateId] = { candidateId, bugType: draft.bugType!, source: input.source!.trim(), sink: input.sink!.trim(), steps: cleanList(input.steps), files, lineHints: input.lineHints ?? [], isReachable: input.reachable ?? false, explanation: input.explanation!.trim(), evidence: cleanList(input.evidence), status: "candidate", createdAt: now() };
          draft.phase = "candidates";
        });
        return result(`Recorded ${candidateId}; validate it before creating a confirmed finding.`, next);
      }

      if (input.action === "validate_candidate") {
        const candidate = input.candidateId ? state.candidates[input.candidateId] : undefined;
        if (!candidate) return result("candidateId is required", state, true);
        if (candidate.status !== "candidate" && candidate.status !== "inconclusive") return result(`Candidate is already ${candidate.status}`, state, true);
        if (input.reachable === undefined || !input.explanation?.trim() || !input.evidence?.length) return result("reachable, explanation, and evidence are required", state, true);
        const next = mutate(`Validated candidate ${candidate.candidateId}`, (draft) => {
          draft.candidates[candidate.candidateId].isReachable = input.reachable!;
          draft.candidates[candidate.candidateId].explanation = input.explanation!.trim();
          draft.candidates[candidate.candidateId].evidence = cleanList(input.evidence);
          draft.candidates[candidate.candidateId].status = input.reachable === draft.isReachable ? "confirmed" : "rejected";
          draft.candidates[candidate.candidateId].validatedAt = now();
          draft.phase = "validated";
        });
        return result(`Candidate ${candidate.candidateId} is ${next.candidates[candidate.candidateId].status}`, next);
      }

      if (input.action === "record_finding") {
        const candidate = input.candidateId ? state.candidates[input.candidateId] : undefined;
        if (!candidate || candidate.status !== "confirmed") return result("A confirmed candidateId is required", state, true);
        if (!input.title?.trim() || !input.description?.trim() || !input.evidence?.length) return result("title, description, and evidence are required", state, true);
        const normalizedFile = input.path?.trim() || candidate.files[0] || "unknown";
        if (normalizedFile !== "unknown" && !state.files[normalizedFile]) return result("path must reference an indexed source file", state, true);
        const duplicate = Object.values(state.findings).find((finding) => finding.candidateId === candidate.candidateId || (finding.title.toLowerCase() === input.title!.trim().toLowerCase() && finding.file === normalizedFile && finding.line === (input.line ?? 0)));
        if (duplicate) return result(`Duplicate finding: ${duplicate.findingId}`, state, true);
        const findingId = makeId("finding");
        const next = mutate(`Recorded finding ${findingId}`, (draft) => {
          draft.findings[findingId] = { findingId, candidateId: candidate.candidateId, bugType: candidate.bugType, language: draft.language, status: "candidate", title: input.title!.trim(), file: normalizedFile, line: input.line ?? candidate.lineHints[0] ?? 0, functionName: input.functionName?.trim() || "unknown", description: input.description!.trim(), evidence: cleanList(input.evidence).join("\n"), explanation: candidate.explanation, humanConfirmed: null, createdAt: now() };
        });
        return result(`Recorded finding ${findingId}; human confirmation is required before finalization.`, next);
      }

      if (input.action === "confirm_finding") {
        const finding = input.findingId ? state.findings[input.findingId] : undefined;
        if (!finding) return result("findingId is required", state, true);
        if (input.humanConfirmed === undefined) return result("humanConfirmed is required", state, true);
        if (config.requireHumanConfirmation && !ctx.hasUI && input.humanConfirmed) return result("Human confirmation requires an interactive Pi UI", state, true);
        const next = mutate(`Set finding ${finding.findingId} confirmation`, (draft) => {
          draft.findings[finding.findingId].humanConfirmed = input.humanConfirmed!;
          draft.findings[finding.findingId].status = input.humanConfirmed ? "confirmed" : "rejected";
          draft.phase = input.humanConfirmed ? "reported" : draft.phase;
        });
        return result(`Finding ${finding.findingId}: ${next.findings[finding.findingId].status}`, next);
      }

      if (input.action === "report") {
        const confirmed = Object.values(state.findings).filter((finding) => finding.status === "confirmed");
        if (input.format === "json") return result(JSON.stringify({ audit: state, confirmedFindings: confirmed }, null, 2), state);
        const lines = [`# RepoAudit Report: ${state.projectName}`, "", `- Audit ID: \`${state.auditId}\``, `- Language: \`${state.language}\``, `- Scan: \`${state.scanType}\``, `- Bug type: \`${state.bugType || "metadata"}\``, `- Confirmed findings: ${confirmed.length}`, ""];
        if (!confirmed.length) lines.push("No human-confirmed findings.", "");
        for (const finding of confirmed) lines.push(`## [${finding.bugType}] ${finding.title}`, `- Location: \`${finding.file}:${finding.line}\``, `- Function: \`${finding.functionName}\``, "", finding.description, "", `**Evidence**\n${finding.evidence}`, "", `**Analysis**\n${finding.explanation}`, "");
        return result(lines.join("\n"), state);
      }

      if (input.action === "finish") {
        if (state.scanType === "dfbscan" && Object.values(state.candidates).some((candidate) => candidate.status === "candidate" || candidate.status === "inconclusive")) return result("Cannot finish while data-flow candidates remain unvalidated", state, true);
        if (Object.values(state.findings).some((finding) => finding.status === "candidate")) return result("Cannot finish while findings await human confirmation", state, true);
        const next = mutate("Finished RepoAudit scan", (draft) => { draft.phase = "completed"; });
        return result(JSON.stringify({ success: true, auditId: next.auditId, confirmedFindings: Object.values(next.findings).filter((finding) => finding.status === "confirmed").length }, null, 2), next);
      }

      if (input.action === "rollback") {
        const snapshot = input.snapshotVersion === undefined ? state.snapshots[0] : state.snapshots.find((item) => item.version === input.snapshotVersion);
        if (!snapshot) return result("No rollback snapshot exists", state, true);
        const restored = clone(snapshot);
        restored.snapshots = state.snapshots.filter((item) => item !== snapshot).slice(0, MAX_SNAPSHOTS);
        persist(restored, "Rolled back RepoAudit state");
        return result("Rolled back. Re-check candidate and finding conclusions.", restored);
      }

      return result(`Unsupported action: ${input.action}`, state, true);
    },
  });

  pi.registerCommand("repoaudit", {
    description: "Show the current RepoAudit summary",
    handler: async (_args, ctx) => {
      if (!state) { ctx.ui.notify("No active RepoAudit session.", "info"); return; }
      ctx.ui.notify(`${state.projectName} - ${state.phase} - ${Object.keys(state.files).length} file(s) - ${Object.keys(state.findings).length} finding(s)`, "info");
    },
  });

  pi.registerCommand("repoaudit-reset", {
    description: "Reset the current RepoAudit session after confirmation",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || !(await ctx.ui.confirm("Reset RepoAudit session", "This clears the active RepoAudit state from the current Pi session."))) return;
      state = undefined;
      pi.appendEntry("repoaudit-reset", { at: now() });
      ctx.ui.notify("RepoAudit session reset.", "info");
    },
  });
}
