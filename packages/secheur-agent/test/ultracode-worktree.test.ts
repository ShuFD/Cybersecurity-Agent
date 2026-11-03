import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyPatch,
	cleanupWorktreeSession,
	createWorktreeSession,
	detectVerificationCommand,
	snapshotCandidate,
} from "../src/ultracode-worktree.ts";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function initializeRepository(directory: string): Promise<void> {
	await execFileAsync("git", ["init", "--quiet"], { cwd: directory });
	await writeFile(join(directory, "tracked.txt"), "committed\n", "utf8");
	await execFileAsync("git", ["add", "tracked.txt"], { cwd: directory });
	await execFileAsync(
		"git",
		["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "initial"],
		{ cwd: directory },
	);
}

describe("ultracode worktree isolation", () => {
	it("captures candidate changes as a patch over the dirty baseline", async () => {
		const repo = await mkdtemp(join(tmpdir(), "secheur-ultracode-worktree-"));
		temporaryDirectories.push(repo);
		await initializeRepository(repo);
		await writeFile(join(repo, "tracked.txt"), "dirty baseline\n", "utf8");
		await writeFile(join(repo, "user-untracked.txt"), "keep me\n", "utf8");
		await writeFile(join(repo, ".gitignore"), "node_modules/\n", "utf8");
		await mkdir(join(repo, "node_modules"));
		await writeFile(join(repo, "node_modules", "dependency.txt"), "shared\n", "utf8");

		const session = await createWorktreeSession(repo, 2);
		try {
			expect(session.candidates).toHaveLength(2);
			await writeFile(join(session.candidates[0].root, "tracked.txt"), "winner\n", "utf8");
			await writeFile(join(session.candidates[0].root, "winner.txt"), "selected\n", "utf8");
			const snapshot = await snapshotCandidate(session, session.candidates[0]);

			expect(snapshot.patch).toContain("winner.txt");
			expect(snapshot.patch).toContain("dirty baseline");
			expect(snapshot.patch).not.toContain("node_modules");
			await applyPatch(repo, snapshot.patch);

			expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("winner\n");
			expect(await readFile(join(repo, "user-untracked.txt"), "utf8")).toBe("keep me\n");
			expect(await readFile(join(repo, "winner.txt"), "utf8")).toBe("selected\n");
		} finally {
			await cleanupWorktreeSession(session);
		}
	});

	it("detects the repository's standard validation command", async () => {
		const repo = await mkdtemp(join(tmpdir(), "secheur-ultracode-validation-"));
		temporaryDirectories.push(repo);
		await writeFile(
			join(repo, "package.json"),
			JSON.stringify({ scripts: { check: "tsc", test: "vitest" } }),
			"utf8",
		);

		expect(detectVerificationCommand(repo)).toBe("npm run check && npm test");
		expect(detectVerificationCommand(repo, "printf custom")).toBe("printf custom");
	});
});
