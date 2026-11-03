#!/usr/bin/env node
import { resolve } from "node:path";
import { createUnixServer } from "@earendil-works/pi-server/unix";
import { SecHeurProtocolService } from "./protocol-service.ts";

interface CliOptions {
	projectRoot: string;
	socketPath?: string;
	databasePath?: string;
	help: boolean;
}

function optionValue(args: string[], index: number): { value: string; consumed: number } {
	const argument = args[index];
	const separator = argument.indexOf("=");
	if (separator >= 0) return { value: argument.slice(separator + 1), consumed: 0 };
	const value = args[index + 1];
	if (!value || value.startsWith("-")) throw new Error(`Missing value for ${argument}`);
	return { value, consumed: 1 };
}

function parseArgs(args: string[]): CliOptions {
	const options: CliOptions = {
		projectRoot: process.env.SECHEUR_PROJECT_ROOT ?? process.env.INIT_CWD ?? process.cwd(),
		help: false,
	};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--help" || argument === "-h") {
			options.help = true;
			continue;
		}
		if (argument === "--project-root" || argument.startsWith("--project-root=")) {
			const parsed = optionValue(args, index);
			options.projectRoot = parsed.value;
			index += parsed.consumed;
			continue;
		}
		if (argument === "--socket" || argument.startsWith("--socket=")) {
			const parsed = optionValue(args, index);
			options.socketPath = parsed.value;
			index += parsed.consumed;
			continue;
		}
		if (argument === "--database" || argument.startsWith("--database=")) {
			const parsed = optionValue(args, index);
			options.databasePath = parsed.value;
			index += parsed.consumed;
			continue;
		}
		throw new Error(`Unknown option: ${argument}`);
	}
	return options;
}

function printHelp(): void {
	console.log(`Usage: secheur-server [options]

Options:
  --project-root <path>  Project root used by SecHeur sessions
  --socket <path>        Unix socket path
  --database <path>      SQLite protocol session database
  -h, --help             Show this help`);
}

async function main(args: string[]): Promise<void> {
	const options = parseArgs(args);
	if (options.help) {
		printHelp();
		return;
	}
	const service = await SecHeurProtocolService.create({
		projectRoot: resolve(options.projectRoot),
		databasePath: options.databasePath ?? process.env.SECHEUR_PROTOCOL_DATABASE,
	});
	const socketPath = resolve(
		options.socketPath ?? process.env.SECHEUR_PROTOCOL_SOCKET ?? `${service.config.stateDir}/secheur.sock`,
	);
	const server = createUnixServer(service, {
		path: socketPath,
		onError: (error) => console.error(error.message),
	});
	try {
		await server.start();
		console.error(`SecHeur Agent protocol server: ${socketPath}`);
		await new Promise<void>((done) => {
			const shutdown = (): void => done();
			process.once("SIGINT", shutdown);
			process.once("SIGTERM", shutdown);
		});
	} finally {
		await server.close();
		await service.close();
	}
}

void main(process.argv.slice(2)).catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
