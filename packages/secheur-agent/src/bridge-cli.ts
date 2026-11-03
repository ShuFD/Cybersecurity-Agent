#!/usr/bin/env node
import { SecHeurBridge } from "./bridge.ts";

function printHelp(): void {
	console.log(`Usage: secheur-bridge

Environment:
  SECHEUR_PROJECT_ROOT  Project root used by SecHeur sessions
  SECHEUR_MANAGED_SESSIONS  Set to 0/false for standalone sessions (default: true)
  SECHEUR_LOAD_PERSISTED_SESSIONS  Set to 0/false to hide persisted history (default: true)
  BRIDGE_HOST           Listen host (default: 127.0.0.1)
  BRIDGE_PORT           Listen port (default: 14168)
  -h, --help            Show this help`);
}

function startBridge(): void {
	const managedSessions = !["0", "false"].includes((process.env.SECHEUR_MANAGED_SESSIONS ?? "1").toLowerCase());
	const bridge = new SecHeurBridge({
		projectRoot: process.env.SECHEUR_PROJECT_ROOT ?? process.env.INIT_CWD ?? process.cwd(),
		host: process.env.BRIDGE_HOST ?? "127.0.0.1",
		port: Number(process.env.BRIDGE_PORT ?? 14168),
		managedSessions,
		worklist: false,
		competition: false,
	});

	void bridge
		.listen()
		.then(() => {
			const address = bridge.address;
			console.error(
				`SecHeur Agent bridge: http://${address.host}:${address.port}  ws://${address.host}:${address.port}/ws`,
			);
		})
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});

	const shutdown = (): void => {
		void bridge.close().finally(() => process.exit(0));
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

if (process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) printHelp();
else startBridge();
