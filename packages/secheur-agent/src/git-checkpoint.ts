import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitCheckpoint {
	id: string;
	ref: string;
	tree: string;
	head?: string;
	reason: string;
	createdAt: string;
	dirty: boolean;
}

interface GitResult {
	stdout: string;
	stderr: string;
	code: number;
}

function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, {
			cwd,
			env: env ? { ...process.env, ...env } : process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
	});
}

async function requireGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
	const result = await runGit(cwd, args, env);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `git ${args[0]} failed with exit code ${result.code}`);
	}
	return result.stdout.trim();
}

/** Capture the complete working tree without touching the user's real index. */
export async function createGitCheckpoint(
	cwd: string,
	reason: string,
	options: { exclude?: string[] } = {},
): Promise<GitCheckpoint | undefined> {
	const probe = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
	if (probe.code !== 0) return undefined;

	const root = probe.stdout.trim();
	const headResult = await runGit(root, ["rev-parse", "--verify", "HEAD"]);
	const head = headResult.code === 0 ? headResult.stdout.trim() : undefined;
	const status = await requireGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
	const tempDir = await mkdtemp(join(tmpdir(), "secheur-checkpoint-"));
	const indexPath = join(tempDir, "index");
	const indexEnv = { GIT_INDEX_FILE: indexPath };

	try {
		if (head) await requireGit(root, ["read-tree", head], indexEnv);
		else await requireGit(root, ["read-tree", "--empty"], indexEnv);
		const addArgs = ["add", "-A", "--", ".", ...(options.exclude ?? []).map((path) => `:(exclude)${path}`)];
		await requireGit(root, addArgs, indexEnv);
		const tree = await requireGit(root, ["write-tree"], indexEnv);
		const commitArgs = ["commit-tree", tree];
		if (head) commitArgs.push("-p", head);
		commitArgs.push("-m", `SecHeur checkpoint: ${reason}`);
		const ref = await requireGit(root, commitArgs, {
			...indexEnv,
			GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "SecHeur Checkpoint",
			GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "secheur-checkpoint@localhost",
			GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "SecHeur Checkpoint",
			GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "secheur-checkpoint@localhost",
		});
		return {
			id: ref.slice(0, 12),
			ref,
			tree,
			head,
			reason,
			createdAt: new Date().toISOString(),
			dirty: status.length > 0,
		};
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}
