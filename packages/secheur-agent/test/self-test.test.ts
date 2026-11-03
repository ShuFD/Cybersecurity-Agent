import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	formatSelfTestJson,
	formatSelfTestText,
	probeBridgeHttp,
	probeBridgeWebSocket,
	probeMcpFixture,
	probeProtocol,
	runIsolatedSelfTest,
	runSelfTest,
	type SelfTestReport,
} from "../src/self-test.ts";

interface SelfTestEnv {
	root: string;
}

function createEnv(): SelfTestEnv {
	const root = mkdtempSync(join(tmpdir(), "secheur-self-test-"));
	return { root };
}

function cleanupEnv(env: SelfTestEnv): void {
	rmSync(env.root, { recursive: true, force: true });
}

function expectReportShape(report: SelfTestReport): void {
	expect(report.steps.length).toBeGreaterThanOrEqual(7);
	const ids = new Set(report.steps.map((step) => step.id));
	for (const id of [
		"legacy-runtime",
		"legacy-tool-search",
		"legacy-list-files",
		"legacy-attack-memory",
		"bridge-http",
		"bridge-websocket",
		"mcp-fixture",
		"protocol",
		"skills",
	]) {
		expect(ids.has(id), `expected step ${id} to exist`).toBe(true);
	}
	for (const step of report.steps) {
		expect(step.id).toBeTypeOf("string");
		expect(step.label).toBeTypeOf("string");
		expect(step.pass).toBeTypeOf("boolean");
		expect(step.durationMs).toBeTypeOf("number");
		expect(step.durationMs).toBeGreaterThanOrEqual(0);
	}
}

describe("SecHeur self-test", () => {
	it("produces a structured report with all expected step ids", async () => {
		const env = createEnv();
		try {
			const report = await runSelfTest({
				projectRoot: env.root,
				stateDir: join(env.root, ".secheur-agent"),
				env: { ...process.env, PATH: process.env.PATH ?? "", PI_OFFLINE: "1" },
			});
			expectReportShape(report);
			expect(typeof report.totalDurationMs).toBe("number");
			expect(report.workspace).toBe(env.root);
		} finally {
			cleanupEnv(env);
		}
	}, 120_000);

	it("formats the report as text and JSON", async () => {
		const env = createEnv();
		try {
			const report = await runSelfTest({
				projectRoot: env.root,
				stateDir: join(env.root, ".secheur-agent"),
				env: { ...process.env, PATH: process.env.PATH ?? "", PI_OFFLINE: "1" },
			});
			const text = formatSelfTestText(report);
			expect(text).toMatch(/SecHeur self-test: (PASS|FAIL)/);
			expect(text).toContain("legacy-runtime");
			const json = formatSelfTestJson(report);
			const parsed = JSON.parse(json) as SelfTestReport;
			expect(parsed.ok).toBe(report.ok);
			expect(parsed.steps).toHaveLength(report.steps.length);
		} finally {
			cleanupEnv(env);
		}
	}, 120_000);

	it("exposes a focused bridge HTTP probe", async () => {
		const env = createEnv();
		try {
			const step = await probeBridgeHttp({
				projectRoot: env.root,
				stateDir: join(env.root, ".secheur-agent"),
				env: { ...process.env, PATH: process.env.PATH ?? "", PI_OFFLINE: "1" },
			});
			expect(step.id).toBe("bridge-http");
			expect(step.pass).toBe(true);
			expect(step.error).toBeUndefined();
		} finally {
			cleanupEnv(env);
		}
	}, 60_000);

	it("exposes a focused WebSocket handshake probe", async () => {
		const env = createEnv();
		try {
			const step = await probeBridgeWebSocket({
				projectRoot: env.root,
				stateDir: join(env.root, ".secheur-agent"),
				env: { ...process.env, PATH: process.env.PATH ?? "", PI_OFFLINE: "1" },
			});
			expect(step.id).toBe("bridge-websocket");
			expect(step.pass).toBe(true);
			expect(step.error).toBeUndefined();
		} finally {
			cleanupEnv(env);
		}
	}, 60_000);

	it("runs the MCP stdio fixture probe with structuredContent and reconnect", async () => {
		const env = createEnv();
		try {
			const step = await probeMcpFixture({
				projectRoot: env.root,
				stateDir: join(env.root, ".secheur-agent"),
				env: { ...process.env, PATH: process.env.PATH ?? "", PI_OFFLINE: "1" },
			});
			expect(step.id).toBe("mcp-fixture");
			expect(step.pass).toBe(true);
			expect(step.error).toBeUndefined();
		} finally {
			cleanupEnv(env);
		}
	}, 60_000);

	it("runs the protocol probe with faux provider and SQLite", async () => {
		const env = createEnv();
		try {
			const step = await probeProtocol(
				{
					projectRoot: env.root,
					stateDir: join(env.root, ".secheur-agent"),
					env: { ...process.env, PATH: process.env.PATH ?? "", PI_OFFLINE: "1" },
				},
				env.root,
			);
			expect(step.id).toBe("protocol");
			if (step.pass === false) console.error("PROTOCOL FAIL:", step.error, step.details);
			expect(step.pass).toBe(true);
			expect(step.error).toBeUndefined();
		} finally {
			cleanupEnv(env);
		}
	}, 120_000);
});

describe.runIf(process.platform !== "win32")("SecHeur self-test CLI dispatch", () => {
	it("runs outside the configured project and removes its temporary workspace", async () => {
		const env = createEnv();
		try {
			const report = await runIsolatedSelfTest({
				projectRoot: env.root,
				stateDir: join(env.root, ".secheur-agent"),
				env: { ...process.env, PATH: process.env.PATH ?? "", PI_OFFLINE: "1" },
			});
			expect(report.workspace).not.toBe(env.root);
			expect(existsSync(report.workspace)).toBe(false);
			expect(existsSync(join(env.root, "sessions.sqlite"))).toBe(false);
			expect(existsSync(join(env.root, ".secheur-agent"))).toBe(false);
			// Contract: ok=true iff all steps pass.
			const derivedOk = report.steps.every((step) => step.pass);
			expect(report.ok).toBe(derivedOk);
			// Force a fail scenario by tampering with one step.
			const tampered: SelfTestReport = {
				...report,
				steps: report.steps.map((step, index) =>
					index === 0 ? { ...step, pass: false, error: step.error ?? "forced failure" } : step,
				),
			};
			expect(tampered.ok).toBe(false);
			expect(tampered.steps[0]?.pass).toBe(false);
		} finally {
			cleanupEnv(env);
		}
	}, 120_000);
});
