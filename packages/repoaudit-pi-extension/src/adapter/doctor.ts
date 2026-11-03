import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { createRuntimeConfig, type RepoAuditRuntimeConfig } from "./config.ts";
import type { RepoAuditErrorCode } from "./contracts.ts";
import { asRepoAuditError, RECOVERY_SUGGESTIONS, RepoAuditError } from "./errors.ts";
import {
	assertRuntimePaths,
	assertTreeSitter,
	getPythonVersion,
	missingPythonDependencies,
	TREE_SITTER_GRAMMARS,
} from "./preflight.ts";

export interface RepoAuditDoctorCheck {
	name: string;
	ok: boolean;
	code?: RepoAuditErrorCode;
	message: string;
	suggestion?: string;
	details?: Record<string, unknown>;
}

export interface RepoAuditDoctorResult {
	ok: boolean;
	generatedAt: string;
	root: { path: string | null; source: "explicit" | "inferred" | "unavailable" };
	model: {
		name: string;
		credentialEnvironmentName: string | null;
		apiKeyPresent: boolean;
	};
	effective: {
		timeoutMs: number;
		maxSymbolicWorkers: number;
		maxNeuralWorkers: number;
		lockTimeoutMs: number;
		lockStaleMs: number;
		heartbeatMs: number;
	};
	checks: RepoAuditDoctorCheck[];
}

export interface RepoAuditDoctorOperations {
	assertRuntimePaths(config: RepoAuditRuntimeConfig): Promise<void>;
	getPythonVersion(config: RepoAuditRuntimeConfig): Promise<string>;
	missingPythonDependencies(config: RepoAuditRuntimeConfig): Promise<string[]>;
	assertTreeSitter(language: keyof typeof TREE_SITTER_GRAMMARS, config: RepoAuditRuntimeConfig): Promise<void>;
	assertWritableDirectory(directory: string): Promise<void>;
}

export interface RepoAuditDoctorOptions {
	environment?: NodeJS.ProcessEnv;
	operations?: Partial<RepoAuditDoctorOperations>;
}

const DEFAULT_OPERATIONS: RepoAuditDoctorOperations = {
	assertRuntimePaths,
	getPythonVersion,
	missingPythonDependencies,
	assertTreeSitter,
	assertWritableDirectory,
};

async function assertWritableDirectory(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true });
	await access(directory, fsConstants.W_OK);
	const probePath = path.join(directory, `.repoaudit-doctor-${process.pid}-${randomUUID()}.tmp`);
	const handle = await open(probePath, "wx");
	try {
		await handle.writeFile("repoaudit-doctor\n", "utf8");
		await handle.sync();
	} finally {
		await handle.close();
		await unlink(probePath).catch(() => undefined);
	}
}

function failureCheck(name: string, error: unknown): RepoAuditDoctorCheck {
	const normalized = asRepoAuditError(error);
	return {
		name,
		ok: false,
		code: normalized.code,
		message: normalized.message,
		suggestion: RECOVERY_SUGGESTIONS[normalized.code],
	};
}

async function fileCheck(name: string, filePath: string, code: RepoAuditErrorCode): Promise<RepoAuditDoctorCheck> {
	try {
		if (!(await stat(filePath)).isFile()) throw new Error("not a file");
		return { name, ok: true, message: "ready", details: { path: filePath } };
	} catch (error) {
		return failureCheck(name, new RepoAuditError(code, `${name} is unavailable.`, { cause: error }));
	}
}

export async function runRepoAuditDoctor(options: RepoAuditDoctorOptions = {}): Promise<RepoAuditDoctorResult> {
	const environment = options.environment ?? process.env;
	const operations = { ...DEFAULT_OPERATIONS, ...options.operations };
	const checks: RepoAuditDoctorCheck[] = [];
	let config: RepoAuditRuntimeConfig;
	try {
		config = createRuntimeConfig(environment);
	} catch (error) {
		checks.push(failureCheck("runtime-root", error));
		return {
			ok: false,
			generatedAt: new Date().toISOString(),
			root: { path: null, source: "unavailable" },
			model: {
				name: environment.REPOAUDIT_MODEL?.trim() || "claude-3.7",
				credentialEnvironmentName: null,
				apiKeyPresent: false,
			},
			effective: {
				timeoutMs: 0,
				maxSymbolicWorkers: 0,
				maxNeuralWorkers: 0,
				lockTimeoutMs: 0,
				lockStaleMs: 0,
				heartbeatMs: 0,
			},
			checks,
		};
	}

	try {
		await operations.assertRuntimePaths(config);
		checks.push({
			name: "runtime-root",
			ok: true,
			message: config.rootSource === "explicit" ? "explicit root" : "inferred root (development fallback)",
			details: { path: config.repoAuditRoot, source: config.rootSource },
		});
	} catch (error) {
		checks.push(failureCheck("runtime-root", error));
	}
	checks.push(await fileCheck("src/repoaudit.py", config.repoAuditEntryPoint, "RUNTIME_NOT_FOUND"));

	let pythonReady = false;
	try {
		const version = await operations.getPythonVersion(config);
		pythonReady = true;
		checks.push({
			name: "python-3.13",
			ok: true,
			message: `Python ${version}`,
			details: { executable: config.pythonExecutable },
		});
	} catch (error) {
		checks.push(failureCheck("python-3.13", error));
	}

	if (pythonReady) {
		try {
			const missing = await operations.missingPythonDependencies(config);
			if (missing.length > 0) {
				throw new RepoAuditError("DEPENDENCY_MISSING", `Missing Python modules: ${missing.join(", ")}.`);
			}
			checks.push({ name: "python-modules", ok: true, message: "all required modules are importable" });
		} catch (error) {
			checks.push(failureCheck("python-modules", error));
		}
	}

	checks.push(await fileCheck("tree-sitter-library", config.treeSitterLibrary, "TREE_SITTER_NOT_READY"));
	if (pythonReady) {
		for (const grammar of Object.keys(TREE_SITTER_GRAMMARS) as Array<keyof typeof TREE_SITTER_GRAMMARS>) {
			try {
				await operations.assertTreeSitter(grammar, config);
				checks.push({ name: `grammar-${grammar}`, ok: true, message: "loadable" });
			} catch (error) {
				checks.push(failureCheck(`grammar-${grammar}`, error));
			}
		}
	}

	if (config.apiKeyEnvironmentName === null) {
		checks.push(
			failureCheck(
				"model-credential-mapping",
				new RepoAuditError("MODEL_CONFIGURATION_ERROR", `Model ${config.modelName} has no credential mapping.`),
			),
		);
	} else {
		checks.push({
			name: "model-credential-mapping",
			ok: true,
			message: `mapped to ${config.apiKeyEnvironmentName}`,
			details: { credentialEnvironmentName: config.apiKeyEnvironmentName },
		});
		const present = Boolean(config.environment[config.apiKeyEnvironmentName]?.trim());
		if (present) {
			checks.push({
				name: "model-api-key",
				ok: true,
				message: "credential is present",
				details: { present: true, required: config.requireApiKey },
			});
		} else if (config.requireApiKey) {
			checks.push(
				failureCheck(
					"model-api-key",
					new RepoAuditError("API_KEY_MISSING", `${config.apiKeyEnvironmentName} is not set.`),
				),
			);
		} else {
			checks.push({
				name: "model-api-key",
				ok: true,
				message: "credential is not present (optional because REPOAUDIT_REQUIRE_API_KEY=0)",
				details: { present: false, required: false },
			});
		}
	}

	for (const [name, directory] of [
		["log-directory", path.join(config.repoAuditRoot, "log")],
		["result-directory", path.join(config.repoAuditRoot, "result")],
		["runs-directory", config.runsDirectory],
		["lock-directory", config.lockDirectory],
	] as const) {
		try {
			await operations.assertWritableDirectory(directory);
			checks.push({ name, ok: true, message: "creatable and writable", details: { path: directory } });
		} catch (error) {
			checks.push(
				failureCheck(name, new RepoAuditError("RUNTIME_NOT_FOUND", `${name} is not writable.`, { cause: error })),
			);
		}
	}

	const apiKeyPresent =
		config.apiKeyEnvironmentName !== null && Boolean(config.environment[config.apiKeyEnvironmentName]?.trim());
	return {
		ok: checks.every((check) => check.ok),
		generatedAt: new Date().toISOString(),
		root: { path: config.repoAuditRoot, source: config.rootSource },
		model: {
			name: config.modelName,
			credentialEnvironmentName: config.apiKeyEnvironmentName,
			apiKeyPresent,
		},
		effective: {
			timeoutMs: config.defaultTimeoutMs,
			maxSymbolicWorkers: config.maxSymbolicWorkers,
			maxNeuralWorkers: config.maxNeuralWorkers,
			lockTimeoutMs: config.lockTimeoutMs,
			lockStaleMs: config.lockStaleMs,
			heartbeatMs: config.heartbeatMs,
		},
		checks,
	};
}
