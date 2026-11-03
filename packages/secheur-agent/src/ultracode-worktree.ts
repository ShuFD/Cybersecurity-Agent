import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createGitCheckpoint, type GitCheckpoint } from "./git-checkpoint.ts";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface CandidateWorktree {
	index: number;
	root: string;
	cwd: string;
}

export interface UltracodeWorktreeSession {
	repoRoot: string;
	baseline: GitCheckpoint;
	tempRoot: string;
	candidates: CandidateWorktree[];
}

export interface CandidateSnapshot {
	checkpoint: GitCheckpoint;
	patch: string;
	stat: string;
}

export interface VerificationResult {
	command: string;
	code: number;
	stdout: string;
	stderr: string;
}

const OUTPUT_LIMIT = 120 * 1024;

export function truncateOutput(value: string, limit = OUTPUT_LIMIT): string {
	if (Buffer.byteLength(value, "utf8") <= limit) return value;
	let result = value.slice(0, limit);
	while (Buffer.byteLength(result, "utf8") > limit) result = result.slice(0, -1);
	return `${result}\n[output truncated]`;
}

export function runCommand(
	command: string,
	args: string[],
	options: {
		cwd: string;
		env?: NodeJS.ProcessEnv;
		input?: string;
		signal?: AbortSignal;
		shell?: boolean;
	},
): Promise<CommandResult> {
	return new Promise((resolveResult, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			shell: options.shell ?? false,
			detached: process.platform !== "win32",
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;

		const kill = () => {
			if (settled) return;
			if (child.pid && process.platform !== "win32") {
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {
					child.kill("SIGTERM");
				}
			} else {
				child.kill("SIGTERM");
			}
			killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
		};

		child.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", kill);
			reject(error);
		});
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", kill);
			resolveResult({ code: code ?? 1, stdout, stderr });
		});

		if (options.signal) {
			if (options.signal.aborted) kill();
			else options.signal.addEventListener("abort", kill, { once: true });
		}
		if (options.input !== undefined) child.stdin?.end(options.input);
	});
}

async function requireCommand(command: string, args: string[], cwd: string, input?: string): Promise<CommandResult> {
	const result = await runCommand(command, args, { cwd, input });
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `${command} ${args.join(" ")} failed with exit code ${result.code}`);
	}
	return result;
}

async function linkSharedDependencies(repoRoot: string, worktreeRoot: string): Promise<void> {
	const dependencies = join(repoRoot, "node_modules");
	if (!existsSync(dependencies)) return;
	try {
		await symlink(
			dependencies,
			join(worktreeRoot, "node_modules"),
			process.platform === "win32" ? "junction" : "dir",
		);
	} catch (error) {
		throw new Error(
			`Could not expose installed dependencies to ultracode worktree ${worktreeRoot}: ${String(error)}`,
		);
	}
}

async function repositoryRoot(cwd: string): Promise<string> {
	const result = await requireCommand("git", ["rev-parse", "--show-toplevel"], cwd);
	return result.stdout.trim();
}

export async function createWorktreeSession(cwd: string, count: number): Promise<UltracodeWorktreeSession> {
	if (count < 1) throw new Error("Ultracode requires at least one candidate");
	const repoRoot = await repositoryRoot(cwd);
	const baseline = await createGitCheckpoint(repoRoot, "ultracode baseline");
	if (!baseline) throw new Error("Ultracode requires a Git repository");

	const tempRoot = await mkdtemp(join(tmpdir(), "secheur-ultracode-"));
	const relativeCwd = relative(repoRoot, resolve(cwd));
	const candidates: CandidateWorktree[] = [];
	try {
		for (let index = 0; index < count; index += 1) {
			const root = join(tempRoot, `candidate-${index + 1}`);
			await requireCommand("git", ["worktree", "add", "--detach", root, baseline.ref], repoRoot);
			const candidate = {
				index,
				root,
				cwd: relativeCwd ? join(root, relativeCwd) : root,
			};
			candidates.push(candidate);
			await linkSharedDependencies(repoRoot, root);
		}
		return { repoRoot, baseline, tempRoot, candidates };
	} catch (error) {
		await cleanupWorktreeSession({ repoRoot, baseline, tempRoot, candidates });
		throw error;
	}
}

export async function snapshotCandidate(
	session: UltracodeWorktreeSession,
	candidate: CandidateWorktree,
): Promise<CandidateSnapshot> {
	const checkpoint = await createGitCheckpoint(candidate.root, `ultracode candidate ${candidate.index + 1}`, {
		exclude: ["node_modules"],
	});
	if (!checkpoint) throw new Error(`Could not snapshot candidate ${candidate.index + 1}`);
	const diff = await requireCommand(
		"git",
		["diff", "--binary", session.baseline.ref, checkpoint.ref, "--"],
		session.repoRoot,
	);
	const stat = await requireCommand(
		"git",
		["diff", "--stat", session.baseline.ref, checkpoint.ref, "--"],
		session.repoRoot,
	);
	return { checkpoint, patch: diff.stdout, stat: stat.stdout.trim() };
}

export async function applyPatch(cwd: string, patch: string): Promise<void> {
	if (!patch.trim()) return;
	const check = await runCommand("git", ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], {
		cwd,
		input: patch,
	});
	if (check.code !== 0) throw new Error(`Winner patch does not apply cleanly: ${check.stderr.trim()}`);
	const result = await runCommand("git", ["apply", "--binary", "--whitespace=nowarn", "-"], { cwd, input: patch });
	if (result.code !== 0) throw new Error(`Winner patch application failed: ${result.stderr.trim()}`);
}

export function detectVerificationCommand(
	repoRoot: string,
	override = process.env.ULTRACODE_VERIFY_COMMAND,
): string | undefined {
	if (override?.trim()) return override.trim();

	const packagePath = join(repoRoot, "package.json");
	if (existsSync(packagePath)) {
		try {
			const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
				scripts?: Record<string, string>;
			};
			if (packageJson.scripts?.check && packageJson.scripts.test) return "npm run check && npm test";
			if (packageJson.scripts?.test) return "npm test";
		} catch {
			// Fall through to other project conventions.
		}
	}

	if (existsSync(join(repoRoot, "pyproject.toml")) || existsSync(join(repoRoot, "pytest.ini"))) {
		return "python3 -m pytest";
	}
	if (existsSync(join(repoRoot, "Cargo.toml"))) return "cargo test";
	if (existsSync(join(repoRoot, "go.mod"))) return "go test ./...";
	return undefined;
}

export async function runVerification(
	cwd: string,
	command: string | undefined,
	signal?: AbortSignal,
): Promise<VerificationResult> {
	if (!command) {
		return { command: "git diff --check", ...(await runCommand("git", ["diff", "--check"], { cwd, signal })) };
	}
	const result = await runCommand("bash", ["-lc", command], { cwd, signal });
	return { command, ...result };
}

export async function cleanupWorktreeSession(session: UltracodeWorktreeSession): Promise<void> {
	for (const candidate of [...session.candidates].reverse()) {
		await runCommand("git", ["worktree", "remove", "--force", candidate.root], { cwd: session.repoRoot });
	}
	await rm(session.tempRoot, { recursive: true, force: true });
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}
