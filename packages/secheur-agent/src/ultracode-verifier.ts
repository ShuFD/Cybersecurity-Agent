import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface VerifierCandidate {
	index: number;
	transcript: string;
}

export interface VerifierRequest {
	problem: string;
	candidates: VerifierCandidate[];
	criteria: Record<string, string>;
	model: string;
	nEvaluations: number;
	pivots: number;
	maxWorkers: number;
	seed: number;
	cache?: string;
}

export interface VerifierSelection {
	index: number;
	best: string;
	scores: number[];
	ranking: number[];
	nComparisons: number;
	criteria: string[];
}

export interface VerifierRuntimeConfig {
	python: string;
	api: string;
	model: string;
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	wholeEndpoint?: boolean;
}

function defaultPython(packageRoot: string): string {
	const configured = process.env.ULTRACODE_PYTHON?.trim() || process.env.SECHEUR_PYTHON?.trim();
	if (configured) return configured;
	const bundled =
		process.platform === "win32"
			? join(packageRoot, ".pi", "ultracode", "venv", "Scripts", "python.exe")
			: join(packageRoot, ".pi", "ultracode", "venv", "bin", "python");
	return existsSync(bundled) ? bundled : "python3";
}

export function getDefaultVerifierPython(packageRoot: string): string {
	return defaultPython(packageRoot);
}

function parseVerifierOutput(stdout: string): VerifierSelection {
	const line = stdout
		.trim()
		.split("\n")
		.reverse()
		.find((item) => item.trim());
	if (!line) throw new Error("Verifier returned no JSON result");
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new Error(`Verifier returned invalid JSON: ${line.slice(0, 500)}`);
	}
	if (!parsed || typeof parsed !== "object") throw new Error("Verifier returned an invalid result");
	const result = parsed as Record<string, unknown>;
	if (typeof result.index !== "number" || !Array.isArray(result.scores) || !Array.isArray(result.ranking)) {
		throw new Error("Verifier result is missing index, scores, or ranking");
	}
	return {
		index: result.index,
		best: typeof result.best === "string" ? result.best : "",
		scores: result.scores.filter((value): value is number => typeof value === "number"),
		ranking: result.ranking.filter((value): value is number => typeof value === "number"),
		nComparisons: typeof result.n_comparisons === "number" ? result.n_comparisons : 0,
		criteria: Array.isArray(result.criteria)
			? result.criteria.filter((value): value is string => typeof value === "string")
			: [],
	};
}

export async function runVerifier(
	request: VerifierRequest,
	config: VerifierRuntimeConfig,
	packageRoot: string,
	signal?: AbortSignal,
): Promise<VerifierSelection> {
	const script = join(packageRoot, "ultracode-verifier.py");
	const child = spawn(config.python, [script], {
		cwd: packageRoot,
		env: {
			...process.env,
			ULTRACODE_VERIFIER_API: config.api,
			ULTRACODE_VERIFIER_API_KEY: config.apiKey ?? "",
			ULTRACODE_VERIFIER_BASE_URL: config.baseUrl,
			ULTRACODE_VERIFIER_MODEL: config.model,
			ULTRACODE_VERIFIER_HEADERS: JSON.stringify(config.headers ?? {}),
			ULTRACODE_VERIFIER_WHOLE_ENDPOINT: config.wholeEndpoint ? "1" : "0",
		},
		detached: process.platform !== "win32",
		stdio: ["pipe", "pipe", "pipe"],
	});

	return new Promise((resolve, reject) => {
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
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			signal?.removeEventListener("abort", kill);
			reject(error);
		});
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			signal?.removeEventListener("abort", kill);
			if (signal?.aborted) {
				reject(new Error("Verifier was aborted"));
				return;
			}
			if (code !== 0) {
				reject(new Error(stderr.trim() || `Verifier exited with code ${code}`));
				return;
			}
			try {
				resolve(parseVerifierOutput(stdout));
			} catch (error) {
				reject(error);
			}
		});

		if (signal) {
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
		child.stdin?.end(JSON.stringify(request));
	});
}
