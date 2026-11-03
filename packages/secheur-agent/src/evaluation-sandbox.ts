import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

/** Trusted controller input, never extracted from a model's task description. */
export interface EvaluationEndpoint {
	host: string;
	port: number;
	transport: "tcp";
}
export interface EvaluationSandboxManifest {
	runId: string;
	challengeId: string;
	image: string;
	attachments: string;
	modelConfig: string;
	endpoints: EvaluationEndpoint[];
	protectedEndpoints: EvaluationEndpoint[];
	/** Controller-only model endpoints. Verification requires a dedicated run-bound HTTP gateway. */
	controlEndpoints?: EvaluationEndpoint[];
	/** Mounted only into the gateway, never into an executor. */
	verifierSocket?: string;
	toolchainDigest: string;
}
function assertDirectory(path: string): string {
	if (!isAbsolute(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())
		throw new Error("Sandbox inputs require an absolute real directory");
	return realpathSync(path);
}
export function validateEvaluationSandbox(manifest: EvaluationSandboxManifest): void {
	if (!manifest.runId.trim() || !manifest.challengeId.trim()) throw new Error("Missing evaluation identity");
	if (!/^(?:.+@)?sha256:[a-f0-9]{64}$/.test(manifest.image)) throw new Error("Evaluation image must be digest-pinned");
	if (!/^[a-f0-9]{64}$/.test(manifest.toolchainDigest)) throw new Error("Missing toolchain fingerprint");
	const attachments = assertDirectory(manifest.attachments);
	const config = assertDirectory(manifest.modelConfig);
	const contains = (parent: string, child: string) => {
		const path = relative(parent, child);
		return !path || (!path.startsWith("..") && !isAbsolute(path));
	};
	if (contains(attachments, config) || contains(config, attachments)) throw new Error("Inputs overlap");
	for (const endpoint of [...manifest.endpoints, ...(manifest.controlEndpoints ?? [])]) {
		if (
			!/^[a-zA-Z0-9:._-]+$/.test(endpoint.host) ||
			!Number.isInteger(endpoint.port) ||
			endpoint.port < 1 ||
			endpoint.port > 65535 ||
			endpoint.transport !== "tcp"
		)
			throw new Error("Invalid endpoint");
		if (
			manifest.protectedEndpoints.some(
				(item) => item.host.toLowerCase() === endpoint.host.toLowerCase() && item.port === endpoint.port,
			)
		)
			throw new Error("Management endpoint cannot enter task scope");
	}
}
/** One internal network and anonymous workspace per run. No host execution fallback. */
export function evaluationContainerArguments(manifest: EvaluationSandboxManifest, network: string): string[] {
	validateEvaluationSandbox(manifest);
	const id = createHash("sha256").update(manifest.runId).digest("hex").slice(0, 24);
	if (network !== `secheur-eval-${id}`) throw new Error("Network must belong to this run");
	return [
		"run",
		"--detach",
		"--name",
		`secheur-eval-${id}`,
		"--network",
		network,
		"--label",
		`secheur.eval.run=${manifest.runId}`,
		"--read-only",
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges",
		"--user",
		"1000:1000",
		"--pids-limit",
		"512",
		"--tmpfs",
		"/tmp:rw,nosuid,nodev,mode=1777",
		"--mount",
		`type=volume,src=secheur-eval-work-${id},dst=/workspace`,
		"--mount",
		`type=volume,src=secheur-eval-state-${id},dst=/state`,
		"--workdir",
		"/workspace",
		"--mount",
		`type=bind,src=${realpathSync(manifest.attachments)},dst=/attachments,readonly`,
		"--mount",
		`type=bind,src=${realpathSync(manifest.modelConfig)},dst=/model-config,readonly`,
		"--env",
		"TMPDIR=/tmp",
		"--env",
		"HOME=/state",
		"--env",
		"SECHEUR_STATE_DIR=/state",
		"--env",
		"SECHEUR_CONFIG_DIR=/state",
		"--env",
		`SECHEUR_EVAL_RUN_ID=${manifest.runId}`,
		manifest.image,
	];
}

export function evaluationRunNetwork(runId: string): { name: string; arguments: string[] } {
	const name = `secheur-eval-${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`;
	return { name, arguments: ["network", "create", "--internal", "--label", `secheur.eval.run=${runId}`, name] };
}
