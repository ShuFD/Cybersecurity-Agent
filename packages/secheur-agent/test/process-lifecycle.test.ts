import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { LegacyToolHost } from "../src/legacy-host.ts";
import { McpManager } from "../src/mcp.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "secheur-process-test-"));
	temporaryRoots.push(root);
	return root;
}

function writeExecutable(path: string, source: string): void {
	writeFileSync(path, source, "utf8");
	chmodSync(path, 0o755);
}

function launchCount(path: string): number {
	if (!existsSync(path)) return 0;
	return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("stdio process lifecycle", () => {
	it("isolates a real broken legacy stdin pipe and restarts only the failed host", async () => {
		const root = temporaryRoot();
		const legacyRoot = join(root, "legacy");
		const executable = join(root, "fake-python");
		const ready = join(root, "closed-stdin");
		mkdirSync(join(legacyRoot, "assets"), { recursive: true });
		writeFileSync(join(legacyRoot, "secheur_pi_bridge.py"), "");
		writeFileSync(join(legacyRoot, "assets", "tools_schema.json"), "[]");
		writeExecutable(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv[2] === "-c") {
  process.stdout.write(JSON.stringify({ version: [3, 11, 0], missing: [] }));
  process.exit(0);
}
const root = process.argv[process.argv.indexOf("--cwd") + 1];
const marker = path.join(root, "closed-stdin");
if (!fs.existsSync(marker) && process.env.SECHEUR_TEST_HEALTHY_HOST !== "1") {
  fs.closeSync(0);
  fs.writeFileSync(marker, "ready");
  setInterval(() => {}, 1000);
} else {
  require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, content: "recovered" }) + "\\n");
  });
}
`);
		const config = { ...loadSecHeurConfig({ projectRoot: root, legacyRoot, env: {} }), pythonExecutable: executable };
		const host = new LegacyToolHost(config);
		const sibling = new LegacyToolHost(config, undefined, { ...process.env, SECHEUR_TEST_HEALTHY_HOST: "1" });
		try {
			const first = host.call("fixture", {}).catch((error: unknown) => error);
			await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
			await expect(host.call("fixture", { padding: "x".repeat(1024 * 1024) })).rejects.toThrow(/EPIPE|closed|exited|writable/);
			expect(await first).toBeInstanceOf(Error);
			await expect(sibling.call("fixture", {})).resolves.toMatchObject({ ok: true, content: "recovered" });
			await expect(host.call("fixture", {})).resolves.toMatchObject({ ok: true, content: "recovered" });
			await new Promise<void>((resolve) => setTimeout(resolve, 30));
			await expect(host.call("fixture", {})).resolves.toMatchObject({ ok: true, content: "recovered" });
		} finally {
			host.close();
			sibling.close();
		}
	});

	it("sends independent memory and attack knowledge-base flags with every Legacy request", async () => {
		const root = temporaryRoot();
		const legacyRoot = join(root, "legacy");
		const executable = join(root, "fake-python");
		mkdirSync(join(legacyRoot, "assets"), { recursive: true });
		writeFileSync(join(legacyRoot, "secheur_pi_bridge.py"), "", "utf8");
		writeFileSync(join(legacyRoot, "assets", "tools_schema.json"), "[]", "utf8");
		writeExecutable(
			executable,
			`#!/usr/bin/env node
if (process.argv[2] === "-c") {
  process.stdout.write(JSON.stringify({ version: [3, 11, 0], missing: [] }));
  process.exit(0);
}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({
    id: request.id,
    ok: true,
    data: {
      memoryReferenceEnabled: request.memoryReferenceEnabled,
      knowledgeBaseEnabled: request.knowledgeBaseEnabled,
    },
  }) + "\\n");
});
`,
		);
		const loaded = loadSecHeurConfig({ projectRoot: root, legacyRoot, env: {} });
		const host = new LegacyToolHost({ ...loaded, pythonExecutable: executable });
		try {
			host.setMemoryReferenceEnabled(false);
			host.setKnowledgeBaseEnabled(true);
			await expect(host.call("fixture", {})).resolves.toMatchObject({
				data: { memoryReferenceEnabled: false, knowledgeBaseEnabled: true },
			});

			host.setMemoryReferenceEnabled(true);
			host.setKnowledgeBaseEnabled(false);
			await expect(host.call("fixture", {})).resolves.toMatchObject({
				data: { memoryReferenceEnabled: true, knowledgeBaseEnabled: false },
			});
		} finally {
			host.close();
		}
	});

	it("terminates and restarts the legacy host when a tool call is aborted", async () => {
		const root = temporaryRoot();
		const legacyRoot = join(root, "legacy");
		const launches = join(root, "legacy-launches.txt");
		const executable = join(root, "fake-python");
		mkdirSync(join(legacyRoot, "assets"), { recursive: true });
		writeFileSync(join(legacyRoot, "secheur_pi_bridge.py"), "", "utf8");
		writeFileSync(join(legacyRoot, "assets", "tools_schema.json"), "[]", "utf8");
		writeExecutable(
			executable,
			`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv[2] === "-c") {
  process.stdout.write(JSON.stringify({ version: [3, 11, 0], missing: [] }));
  process.exit(0);
}
const cwdIndex = process.argv.indexOf("--cwd");
const projectRoot = cwdIndex >= 0 ? process.argv[cwdIndex + 1] : process.cwd();
fs.appendFileSync(path.join(projectRoot, "legacy-launches.txt"), String(process.pid) + "\\n");
process.stdin.resume();
`,
		);
		const loaded = loadSecHeurConfig({ projectRoot: root, legacyRoot, env: {} });
		const host = new LegacyToolHost({ ...loaded, pythonExecutable: executable });
		try {
			const firstController = new AbortController();
			const firstCall = host.call("fixture", {}, firstController.signal);
			await vi.waitFor(() => expect(launchCount(launches)).toBe(1));
			firstController.abort();
			await expect(firstCall).rejects.toThrow("Legacy tool aborted: fixture");

			const secondController = new AbortController();
			const secondCall = host.call("fixture", {}, secondController.signal);
			const secondResult = secondCall.then(
				() => undefined,
				(error: unknown) => error,
			);
			try {
				await vi.waitFor(() => expect(launchCount(launches)).toBe(2));
			} finally {
				secondController.abort();
			}
			expect(await secondResult).toMatchObject({ message: "Legacy tool aborted: fixture" });
		} finally {
			host.close();
		}
	});

	it("passes the injected environment to Legacy tools and honors a per-call timeout", async () => {
		const root = temporaryRoot();
		const legacyRoot = join(root, "legacy");
		const marker = join(root, "legacy-environment.txt");
		const executable = join(root, "fake-python");
		mkdirSync(join(legacyRoot, "assets"), { recursive: true });
		writeFileSync(join(legacyRoot, "secheur_pi_bridge.py"), "", "utf8");
		writeFileSync(join(legacyRoot, "assets", "tools_schema.json"), "[]", "utf8");
		writeExecutable(
			executable,
			`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv[2] === "-c") {
  process.stdout.write(JSON.stringify({ version: [3, 11, 0], missing: [] }));
  process.exit(0);
}
const cwdIndex = process.argv.indexOf("--cwd");
const projectRoot = cwdIndex >= 0 ? process.argv[cwdIndex + 1] : process.cwd();
fs.writeFileSync(path.join(projectRoot, "legacy-environment.txt"), process.env.SECHEUR_TEST_INJECTED_ENV || "missing");
process.stdin.resume();
`,
		);
		const loaded = loadSecHeurConfig({ projectRoot: root, legacyRoot, env: {} });
		const host = new LegacyToolHost({ ...loaded, pythonExecutable: executable }, undefined, {
			...process.env,
			SECHEUR_TEST_INJECTED_ENV: "injected",
		});
		try {
			await expect(host.call("fixture", {}, undefined, 250)).rejects.toThrow("Legacy tool timed out: fixture");
			expect(readFileSync(marker, "utf8")).toBe("injected");
		} finally {
			host.close();
		}
	});

	it("removes MCP abort listeners after a successful stdio request", async () => {
		const root = temporaryRoot();
		const serverPath = join(root, "mcp-server.cjs");
		writeFileSync(
			serverPath,
			`const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result = {};
  if (request.method === "initialize") result = { protocolVersion: "2025-11-25" };
  if (request.method === "tools/list") {
    result = { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] };
  }
  if (request.method === "tools/call") {
    result = {
      content: [{ type: "text", text: "ok" }],
      structuredContent: { result: { path: "/work/sample.bin", file: "ELF 64-bit" } },
    };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`,
			"utf8",
		);
		const manager = new McpManager({
			fixture: {
				transport: "stdio",
				command: process.execPath,
				args: [serverPath],
				env: {},
				cwd: root,
				timeoutMs: 2_000,
				protocolVersion: "2025-11-25",
			},
		});
		try {
			const tools = await manager.refresh();
			const controller = new AbortController();
			const removeListener = vi.spyOn(controller.signal, "removeEventListener");
			expect(manager.legacyToolSchemas).toEqual([
				{
					type: "function",
					function: {
						name: "mcp__fixture__echo",
						description: "Echo",
						parameters: { type: "object" },
					},
				},
			]);

			await expect(
				manager.callTool(tools[0].exposedName, { value: "ok" }, controller.signal),
			).resolves.toMatchObject({
				content: [{ type: "text", text: "ok" }],
				structuredContent: {
					result: { path: "/work/sample.bin", file: "ELF 64-bit" },
				},
			});
			expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
		} finally {
			await manager.close();
		}
	});

	it("sends the MCP initialized notification once over HTTP", async () => {
		let initializedNotifications = 0;
		const server = createServer((request, response) => {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk: string) => {
				body += chunk;
			});
			request.on("end", () => {
				const payload = JSON.parse(body) as { id?: number; method?: string };
				if (payload.method === "notifications/initialized") initializedNotifications += 1;
				const result =
					payload.method === "initialize"
						? { protocolVersion: "2025-11-25" }
						: payload.method === "tools/list"
							? { tools: [] }
							: {};
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({ jsonrpc: "2.0", ...(payload.id === undefined ? {} : { id: payload.id }), result }),
				);
			});
		});
		await new Promise<void>((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolveListen);
		});
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("MCP test server has no TCP address");
			const manager = new McpManager({
				fixture: {
					transport: "http",
					url: `http://127.0.0.1:${address.port}`,
					headers: {},
					timeoutMs: 2_000,
					protocolVersion: "2025-11-25",
				},
			});
			await manager.refresh();
			await manager.close();
			expect(initializedNotifications).toBe(1);
		} finally {
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		}
	});

	it("aborts an in-flight HTTP refresh when the MCP manager closes", async () => {
		let requestCount = 0;
		const server = createServer(() => {
			requestCount += 1;
		});
		await new Promise<void>((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolveListen);
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("MCP test server has no TCP address");
		const manager = new McpManager({
			fixture: {
				transport: "http",
				url: `http://127.0.0.1:${address.port}`,
				headers: {},
				timeoutMs: 2_000,
				protocolVersion: "2025-11-25",
			},
		});
		const refreshResult = manager.refresh().then(
			() => "resolved" as const,
			() => "rejected" as const,
		);
		let quickResult: "pending" | "rejected" | "resolved";
		try {
			await vi.waitFor(() => expect(requestCount).toBe(1));
			await manager.close();
			quickResult = await Promise.race([
				refreshResult,
				new Promise<"pending">((resolvePending) => {
					const timer = setTimeout(() => resolvePending("pending"), 250);
					timer.unref();
				}),
			]);
		} finally {
			server.closeAllConnections();
			await refreshResult;
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		}
		expect(quickResult).toBe("rejected");
	});
});
