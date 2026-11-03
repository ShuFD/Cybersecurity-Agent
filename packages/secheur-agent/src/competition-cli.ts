#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CompetitionBroker } from "./competition-broker.ts";
import { CompetitionBrokerServer } from "./competition-protocol-service.ts";
import {
	type CompetitionAdapterBuild,
	type CompetitionAdapterConfigPatch,
	type CompetitionAdapterRuntimeConfig,
	competitionAdapterConfigFromEnvironment,
	createCompetitionAdapter,
	resolveCompetitionAdapterConfig,
} from "./competition-runtime.ts";
import { loadSecHeurConfig } from "./config.ts";
import { competitionSocketPath as deriveCompetitionSocketPath } from "./session-registry.ts";

interface CliOptions {
	projectRoot: string;
	socketPath?: string;
	databasePath?: string;
	sync: boolean;
	help: boolean;
}

function valueFor(args: string[], index: number): { value: string; consumed: number } {
	const argument = args[index] ?? "";
	const separator = argument.indexOf("=");
	if (separator >= 0) return { value: argument.slice(separator + 1), consumed: 0 };
	const value = args[index + 1];
	if (!value || value.startsWith("-")) throw new Error(`Missing value for ${argument}`);
	return { value, consumed: 1 };
}

function parseArgs(args: string[]): CliOptions {
	const options: CliOptions = {
		projectRoot: process.env.SECHEUR_PROJECT_ROOT ?? process.cwd(),
		sync: false,
		help: false,
	};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index] ?? "";
		if (argument === "--help" || argument === "-h") {
			options.help = true;
			continue;
		}
		if (argument === "--sync") {
			options.sync = true;
			continue;
		}
		if (argument === "--project-root" || argument.startsWith("--project-root=")) {
			const parsed = valueFor(args, index);
			options.projectRoot = parsed.value;
			index += parsed.consumed;
			continue;
		}
		if (argument === "--socket" || argument.startsWith("--socket=")) {
			const parsed = valueFor(args, index);
			options.socketPath = parsed.value;
			index += parsed.consumed;
			continue;
		}
		if (argument === "--database" || argument.startsWith("--database=")) {
			const parsed = valueFor(args, index);
			options.databasePath = parsed.value;
			index += parsed.consumed;
			continue;
		}
		throw new Error(`Unknown option: ${argument}`);
	}
	return options;
}

function printHelp(): void {
	console.log(`Usage: secheur-competition [options]

Options:
  --project-root <path>  SecHeur project root
  --database <path>      Competition SQLite database
  --socket <path>        Competition Unix socket
  --sync                 Fetch and persist the current challenge snapshots
  -h, --help             Show this help`);
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
	const options = parseArgs(args);
	if (options.help) {
		printHelp();
		return;
	}
	const projectRoot = resolve(options.projectRoot);
	const config = loadSecHeurConfig({ projectRoot, env: process.env });
	const maxEnvironmentSlots = Number(process.env.COMPETITION_MAX_ENVIRONMENTS ?? 3);
	const initialConfig = competitionAdapterConfigFromEnvironment(process.env);
	const initialBuild = createCompetitionAdapter(initialConfig, {
		config,
		env: process.env,
		maxEnvironmentSlots,
	});
	let currentConfig: CompetitionAdapterRuntimeConfig = initialBuild.config;
	const reconfigureAdapter = async (patch: CompetitionAdapterConfigPatch): Promise<CompetitionAdapterBuild> => {
		const nextConfig = resolveCompetitionAdapterConfig(patch, currentConfig, process.env);
		const nextBuild = createCompetitionAdapter(nextConfig, {
			config,
			env: process.env,
			maxEnvironmentSlots,
			slabApi: initialBuild.attachmentApi,
		});
		currentConfig = nextBuild.config;
		return nextBuild;
	};
	const broker = await CompetitionBroker.open({
		databasePath:
			options.databasePath ?? process.env.SECHEUR_COMPETITION_DATABASE ?? `${config.stateDir}/competition.sqlite`,
		adapter: initialBuild.adapter,
		adapterSummary: initialBuild.summary,
		reconfigureAdapter,
		maxEnvironmentSlots,
	});
	const server = new CompetitionBrokerServer({
		broker,
		socketPath: resolve(
			options.socketPath ?? process.env.SECHEUR_COMPETITION_SOCKET ?? deriveCompetitionSocketPath(config.stateDir),
		),
	});
	try {
		if (options.sync) console.error(JSON.stringify(await broker.sync(), null, 2));
		await server.start();
		console.error(`SecHeur competition broker: ${server.socketPath}`);
		await new Promise<void>((resolvePromise) => {
			process.once("SIGINT", resolvePromise);
			process.once("SIGTERM", resolvePromise);
		});
	} finally {
		await server.close();
		await broker.close();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	void main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
