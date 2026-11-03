import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SecHeurConfig } from "./config.ts";

export interface LegacyEnvironmentDiagnostic {
	ready: boolean;
	pythonExecutable: string;
	pythonVersion?: string;
	legacyRoot: string;
	bridgePath: string;
	toolSchemaPath: string;
	missingPackages: string[];
	errors: string[];
	setupCommands: string[];
}

const REQUIRED_MODULES: Record<string, string> = {
	requests: "requests",
	bs4: "beautifulsoup4",
	bottle: "bottle",
	simple_websocket_server: "simple-websocket-server",
	aiohttp: "aiohttp",
};

const PYTHON_PROBE = [
	"import importlib.util, json, sys",
	`modules = ${JSON.stringify(Object.keys(REQUIRED_MODULES))}`,
	"missing = [name for name in modules if importlib.util.find_spec(name) is None]",
	"print(json.dumps({'version': list(sys.version_info[:3]), 'missing': missing}))",
].join("; ");

function quoteArgument(value: string): string {
	if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function setupCommands(config: SecHeurConfig): string[] {
	const venvRoot = join(config.stateDir, "python");
	const venvPython =
		process.platform === "win32" ? join(venvRoot, "Scripts", "python.exe") : join(venvRoot, "bin", "python");
	const bootstrapPython = process.platform === "win32" ? "py -3.11" : "python3.11";
	return [
		`${bootstrapPython} -m venv ${quoteArgument(venvRoot)}`,
		`${quoteArgument(venvPython)} -m pip install ${quoteArgument(config.legacyRoot)}`,
	];
}

export function inspectLegacyEnvironment(config: SecHeurConfig): LegacyEnvironmentDiagnostic {
	const bridgePath = join(config.legacyRoot, "secheur_pi_bridge.py");
	const toolSchemaPath = join(config.legacyRoot, "assets", "tools_schema.json");
	const errors: string[] = [];
	if (!existsSync(bridgePath)) errors.push(`Missing legacy bridge: ${bridgePath}`);
	if (!existsSync(toolSchemaPath)) errors.push(`Missing legacy tool schema: ${toolSchemaPath}`);
	let pythonVersion: string | undefined;
	let missingPackages: string[] = [];
	const probe = spawnSync(config.pythonExecutable, ["-c", PYTHON_PROBE], {
		encoding: "utf8",
		timeout: 10_000,
		windowsHide: true,
	});
	if (probe.error) {
		errors.push(`Cannot run Python executable ${config.pythonExecutable}: ${probe.error.message}`);
	} else if (probe.status !== 0) {
		const detail = probe.stderr.trim() || `exit status ${probe.status ?? "unknown"}`;
		errors.push(`Python probe failed for ${config.pythonExecutable}: ${detail}`);
	} else {
		try {
			const parsed = JSON.parse(probe.stdout.trim()) as { version?: unknown; missing?: unknown };
			const version = Array.isArray(parsed.version) ? parsed.version.map(Number) : [];
			if (version.length >= 2 && version.every(Number.isFinite)) {
				pythonVersion = version.join(".");
				if (version[0] !== 3 || version[1] < 10 || version[1] >= 14) {
					errors.push(`Unsupported Python version ${pythonVersion}; SecHeur requires Python >=3.10,<3.14`);
				}
			} else {
				errors.push("Python probe returned an invalid version");
			}
			missingPackages = Array.isArray(parsed.missing)
				? parsed.missing.flatMap((name) =>
						typeof name === "string" && REQUIRED_MODULES[name] ? [REQUIRED_MODULES[name]] : [],
					)
				: [];
		} catch (error) {
			errors.push(`Python probe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return {
		ready: errors.length === 0 && missingPackages.length === 0,
		pythonExecutable: config.pythonExecutable,
		pythonVersion,
		legacyRoot: config.legacyRoot,
		bridgePath,
		toolSchemaPath,
		missingPackages,
		errors,
		setupCommands: setupCommands(config),
	};
}

export function formatLegacyEnvironmentReport(diagnostic: LegacyEnvironmentDiagnostic): string {
	const lines = [
		diagnostic.ready ? "Legacy Python runtime is ready." : "Legacy Python runtime is not ready.",
		`Python: ${diagnostic.pythonExecutable}${diagnostic.pythonVersion ? ` (${diagnostic.pythonVersion})` : ""}`,
		`Legacy root: ${diagnostic.legacyRoot}`,
	];
	for (const error of diagnostic.errors) lines.push(`- ${error}`);
	if (diagnostic.missingPackages.length > 0) {
		lines.push(`- Missing Python packages: ${diagnostic.missingPackages.join(", ")}`);
	}
	if (!diagnostic.ready) {
		lines.push("Install the compatibility runtime:", ...diagnostic.setupCommands);
	}
	return lines.join("\n");
}
