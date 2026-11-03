import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { RepoAuditRuntimeConfig } from "./config.ts";
import type { RepoAuditRunOptions } from "./contracts.ts";
import { RepoAuditError } from "./errors.ts";

export interface ArtifactSnapshot {
	logParentDirectory: string;
	resultParentDirectory: string;
	logDirectories: ReadonlySet<string>;
	resultDirectories: ReadonlySet<string>;
}

export interface LocatedArtifacts {
	logDirectory: string;
	resultDirectory: string | null;
	logPath: string;
	reportPath: string | null;
}

async function listDirectories(parentDirectory: string): Promise<Set<string>> {
	try {
		const entries = await readdir(parentDirectory, { withFileTypes: true });
		return new Set(
			entries.filter((entry) => entry.isDirectory()).map((entry) => path.resolve(parentDirectory, entry.name)),
		);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return new Set();
		throw error;
	}
}

export function artifactParentDirectories(
	options: RepoAuditRunOptions,
	canonicalRepoPath: string,
	config: RepoAuditRuntimeConfig,
): { logParentDirectory: string; resultParentDirectory: string } {
	const projectName = path.basename(canonicalRepoPath);
	const segments = ["dfbscan", config.modelName, options.bugType, options.language, projectName];
	return {
		logParentDirectory: path.join(config.repoAuditRoot, "log", ...segments),
		resultParentDirectory: path.join(config.repoAuditRoot, "result", ...segments),
	};
}

export async function snapshotArtifacts(
	options: RepoAuditRunOptions,
	canonicalRepoPath: string,
	config: RepoAuditRuntimeConfig,
): Promise<ArtifactSnapshot> {
	const parents = artifactParentDirectories(options, canonicalRepoPath, config);
	const [logDirectories, resultDirectories] = await Promise.all([
		listDirectories(parents.logParentDirectory),
		listDirectories(parents.resultParentDirectory),
	]);
	return { ...parents, logDirectories, resultDirectories };
}

function difference(after: ReadonlySet<string>, before: ReadonlySet<string>): string[] {
	return [...after].filter((candidate) => !before.has(candidate));
}

function isWithin(candidate: string, parent: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function existingFile(candidate: string): Promise<string | null> {
	try {
		if (!(await stat(candidate)).isFile()) return null;
		return await realpath(candidate);
	} catch {
		return null;
	}
}

export async function locateArtifacts(
	before: ArtifactSnapshot,
	after: ArtifactSnapshot,
	config: RepoAuditRuntimeConfig,
	expectedRunId?: string,
): Promise<LocatedArtifacts> {
	const newLogDirectories = difference(after.logDirectories, before.logDirectories);
	const newResultDirectories = difference(after.resultDirectories, before.resultDirectories);
	if (newLogDirectories.length === 0) {
		throw new RepoAuditError("RESULT_NOT_FOUND", "未找到本次运行唯一的新 log artifact。");
	}
	if (newLogDirectories.length > 1 || newResultDirectories.length > 1) {
		throw new RepoAuditError("RESULT_AMBIGUOUS", "本次运行产生了多个候选 artifact 目录。");
	}
	if (expectedRunId !== undefined) {
		const expectedLog = path.join(before.logParentDirectory, expectedRunId);
		const expectedResult = path.join(before.resultParentDirectory, expectedRunId);
		if (newLogDirectories[0] !== expectedLog || newResultDirectories[0] !== expectedResult) {
			throw new RepoAuditError("RESULT_AMBIGUOUS", "Runtime artifacts were not isolated under the expected run ID.");
		}
	}
	const logDirectory = newLogDirectories[0] as string;
	const resultDirectory = newResultDirectories[0] ?? null;
	const logPath = await existingFile(path.join(logDirectory, "dfbscan.log"));
	if (logPath === null) {
		throw new RepoAuditError("RESULT_NOT_FOUND", "新 log 目录中缺少 dfbscan.log。");
	}
	const canonicalLogRoot = path.resolve(config.repoAuditRoot, "log");
	const canonicalResultRoot = path.resolve(config.repoAuditRoot, "result");
	if (!isWithin(logPath, canonicalLogRoot)) {
		throw new RepoAuditError("RESULT_NOT_FOUND", "log artifact 超出允许目录。", {
			recoverable: false,
		});
	}
	let reportPath: string | null = null;
	if (resultDirectory !== null) {
		reportPath = await existingFile(path.join(resultDirectory, "detect_info.json"));
		if (reportPath !== null && !isWithin(reportPath, canonicalResultRoot)) {
			throw new RepoAuditError("RESULT_NOT_FOUND", "result artifact 超出允许目录。", {
				recoverable: false,
			});
		}
	}
	return {
		logDirectory,
		resultDirectory,
		logPath,
		reportPath,
	};
}
