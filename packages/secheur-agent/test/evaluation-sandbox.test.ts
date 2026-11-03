import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	evaluationContainerArguments,
	evaluationRunNetwork,
	type EvaluationSandboxManifest,
} from "../src/evaluation-sandbox.ts";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function manifest(): EvaluationSandboxManifest {
	const root = mkdtempSync(join(tmpdir(), "sandbox-"));
	roots.push(root);
	for (const name of ["attachments", "config"]) mkdirSync(join(root, name));
	return {
		runId: "fresh-run",
		challengeId: "synthetic",
		image: `image@sha256:${"a".repeat(64)}`,
		toolchainDigest: "b".repeat(64),
		attachments: join(root, "attachments"),
		modelConfig: join(root, "config"),
		endpoints: [{ host: "100.85.231.58", port: 44140, transport: "tcp" }],
		protectedEndpoints: [{ host: "100.85.231.58", port: 22, transport: "tcp" }],
	};
}
it("creates independent filesystems and an internal network without host mounts", () => {
	const input = manifest();
	const network = evaluationRunNetwork(input.runId);
	expect(network.arguments).toContain("--internal");
	const args = evaluationContainerArguments(input, network.name);
	expect(args).toContain("--cap-drop=ALL");
	expect(args).toContain("--read-only");
	expect(args.join(" ")).not.toContain("docker.sock");
	expect(args.filter((arg) => arg.startsWith("type=bind"))).toHaveLength(2);
	const other = evaluationRunNetwork("another-run");
	expect(other.name).not.toBe(network.name);
	expect(() => evaluationContainerArguments(input, other.name)).toThrow("belong");
});
it("permits only exact task endpoints, not other ports on the same server", () => {
	const input = manifest();
	input.endpoints[0].port = 22;
	expect(() => evaluationContainerArguments(input, evaluationRunNetwork(input.runId).name)).toThrow("Management");
});
it("rejects mutable images and absent provenance", () => {
	const input = manifest();
	input.image = "image:latest";
	expect(() => evaluationContainerArguments(input, evaluationRunNetwork(input.runId).name)).toThrow("digest-pinned");
});
