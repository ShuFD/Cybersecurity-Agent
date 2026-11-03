#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { main } from "@earendil-works/pi-coding-agent";
import repoAuditExtension from "@repoaudit/typescript-adapter";
import { SecHeurBridge } from "./bridge.ts";
import { filterEnabledSkills, piSessionArgs, takeBooleanFlag, takeOption } from "./cli-options.ts";
import { main as runCompetitionCli } from "./competition-cli.ts";
import { CompetitionSolverBinding } from "./competition-solver.ts";
import { loadSecHeurConfig, type PermissionMode, type SecHeurConfig } from "./config.ts";
import { createSecHeurExtension, createSecHeurExtensionFactory, type SecHeurExtensionState } from "./extension.ts";
import { MainAgentController } from "./main-agent.ts";
import { PiSessionHost } from "./pi-session-host.ts";
import { runPlanningSelfTest } from "./planning/self-test.ts";
import { attachProgressivePlanningController, planningExecutorExtensionBundle } from "./planning/session-controller.ts";
import { formatLegacyEnvironmentReport, inspectLegacyEnvironment } from "./python-runtime.ts";
import { formatSelfTestJson, formatSelfTestText, runIsolatedSelfTest } from "./self-test.ts";
import { attachSecHeurSessionPolicy } from "./session-policy.ts";

const VALID_PERMISSION_MODES = new Set<PermissionMode>([
	"default",
	"acceptEdits",
	"dontAsk",
	"bypassPermissions",
	"plan",
]);

function printCommands(): void {
	console.log(`SecHeur Agent commands:
  secheur                     Start the Pi TUI with SecHeur tools
  secheur cli [pi options]    Compatibility alias for the Pi TUI
  secheur launch              Start the attach-only desktop HTTP/WebSocket bridge
  secheur competition         Start the competition broker Unix socket service
  secheur status              Check the configured desktop bridge
  secheur doctor              Check the Python compatibility runtime
  secheur self-test [--json]  Run the offline end-to-end self-test
  secheur planning-self-test  Validate the progressive planning engine
  secheur list                Show these commands

All other Pi options and package commands remain available.`);
}

async function printStatus(environment: NodeJS.ProcessEnv): Promise<void> {
	const url = environment.SECHEUR_STATUS_URL ?? "http://127.0.0.1:14168/status";
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
		const payload: unknown = await response.json();
		if (!response.ok || typeof payload !== "object" || payload === null) {
			throw new Error(`HTTP ${response.status}`);
		}
		const status = payload as Record<string, unknown>;
		console.log(
			JSON.stringify(
				{
					url,
					running: status.running === true,
					ready: status.ready === true,
					projectRoot: status.projectRoot ?? status.project_root ?? null,
					sessionCount: status.sessionCount ?? null,
				},
				null,
				2,
			),
		);
	} catch (error) {
		console.error(
			`SecHeur Agent bridge is unavailable at ${url}: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	}
}

async function runBridge(config: SecHeurConfig, environment: NodeJS.ProcessEnv): Promise<void> {
	const managedSessions = !["0", "false"].includes((environment.SECHEUR_MANAGED_SESSIONS ?? "1").toLowerCase());
	const bridge = new SecHeurBridge({
		projectRoot: config.projectRoot,
		host: environment.BRIDGE_HOST ?? "127.0.0.1",
		port: Number(environment.BRIDGE_PORT ?? 14168),
		env: environment,
		managedSessions,
		worklist: false,
		competition: false,
	});
	await bridge.listen();
	const address = bridge.address;
	console.error(
		`SecHeur Agent bridge: http://${address.host}:${address.port}  ws://${address.host}:${address.port}/ws`,
	);
	try {
		await new Promise<void>((done) => {
			process.once("SIGINT", done);
			process.once("SIGTERM", done);
		});
	} finally {
		await bridge.close();
	}
}

function takeSolverValue(args: string[], names: string[], label: string): { args: string[]; value: string } {
	const result = takeOption(args, names);
	if (result.missingValue || result.value === undefined || !result.value.trim()) {
		throw new Error(`${result.missingValue ?? label} requires a value`);
	}
	return { args: result.args, value: result.value };
}

async function runSolver(args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
	let remaining = args;
	const task = takeSolverValue(remaining, ["--task-id"], "--task-id");
	remaining = task.args;
	const solver = takeSolverValue(remaining, ["--solver-id"], "--solver-id");
	remaining = solver.args;
	const competitionSocket = takeSolverValue(remaining, ["--competition-socket"], "--competition-socket");
	remaining = competitionSocket.args;
	const promptFile = takeSolverValue(remaining, ["--prompt-file"], "--prompt-file");
	remaining = promptFile.args;
	const cwd = takeSolverValue(remaining, ["--cwd"], "--cwd");
	remaining = cwd.args;
	const stateDir = takeSolverValue(remaining, ["--state-dir"], "--state-dir");
	remaining = stateDir.args;
	const projectRoot = takeSolverValue(remaining, ["--project-root"], "--project-root");
	remaining = projectRoot.args;
	const name = takeSolverValue(remaining, ["--name"], "--name");
	remaining = name.args;
	const category = takeOption(remaining, ["--category"]);
	remaining = category.args;
	const mainSession = takeOption(remaining, ["--main-session-id"]);
	remaining = mainSession.args;
	const tmuxTarget = takeOption(remaining, ["--tmux-target"]);
	remaining = tmuxTarget.args;

	const solverEnvironment = {
		...environment,
		SECHEUR_CONFIG_DIR: stateDir.value,
		SECHEUR_PROJECT_ROOT: projectRoot.value,
	};
	const solverConfig = loadSecHeurConfig({
		projectRoot: projectRoot.value,
		stateDir: stateDir.value,
		env: solverEnvironment,
	});
	const prompt = await readFile(promptFile.value, "utf8");
	process.env.PI_CODING_AGENT_DIR = solverConfig.agentDir;
	process.env.SECHEUR_CONFIG_DIR = solverConfig.stateDir;
	process.env.SECHEUR_PROJECT_ROOT = solverConfig.projectRoot;
	process.chdir(cwd.value);
	process.title = `secheur-solver:${task.value}`;
	const binding = new CompetitionSolverBinding({
		socketPath: competitionSocket.value,
		taskId: task.value,
		solverId: solver.value,
	});
	let host: PiSessionHost | undefined;
	let extensionState: SecHeurExtensionState | undefined;
	try {
		const envelope = await binding.claim();
		const initialPrompt = [
			prompt.trim(),
			"Authoritative broker envelope (already claimed for this solver):",
			JSON.stringify(envelope, null, 2),
		].join("\n\n");
		const extension = createSecHeurExtensionFactory({
			config: solverConfig,
			competition: binding,
			onState: (state) => {
				extensionState = state;
			},
		});
		await main(piSessionArgs([...remaining, initialPrompt], solverConfig), {
			extensionFactories: [extension],
			skillsOverride: (base) => filterEnabledSkills(solverConfig, base),
			configureSession: (session) => {
				attachSecHeurSessionPolicy(session, solverConfig);
				attachProgressivePlanningController(session, {
					config: solverConfig,
					cwd: solverConfig.projectRoot,
					outerTaskId: `competition:${task.value}:${solver.value}`,
					createExtensionBundle() {
						const child = createSecHeurExtension({
							config: solverConfig,
							permissionMode: "dontAsk",
							env: solverEnvironment,
							subAgentDepth: 1,
							allowKnowledgeBaseRetrieval: session.getAllTools().some((tool) => tool.name === "attack_memory_search"),
							registerInactiveKnowledgeBaseTool: true,
							reloadKnowledgeBaseConfigBeforePrompt: true,
							competition: binding,
						});
						return planningExecutorExtensionBundle(child.extension, () => child.state.close(), [
							repoAuditExtension,
						]);
					},
				});
			},
			onRuntimeReady: async (runtime) => {
				runtime.session.setSessionName(name.value);
				host = new PiSessionHost(runtime, {
					stateDir: stateDir.value,
					role: "solver",
					title: name.value,
					taskId: task.value,
					...(category.value ? { category: category.value } : {}),
					...(mainSession.value
						? { parentMainSessionId: mainSession.value, mainSessionId: mainSession.value }
						: {}),
					...(tmuxTarget.value ? { tmuxTarget: tmuxTarget.value } : {}),
					...(extensionState ? { permissionController: extensionState.permissions } : {}),
				});
				await host.start();
			},
		});
	} catch (error) {
		await binding
			.sendEvent("blocked", {
				category: "solver",
				reason: error instanceof Error ? error.message : String(error),
			})
			.catch(() => undefined);
		throw error;
	} finally {
		await host?.close();
		binding.close();
	}
}

async function mainCli(argv: string[]): Promise<void> {
	const knowledgeBase = takeBooleanFlag(argv, ["--use-knowledge-base", "--knowledge-base"]);
	if (knowledgeBase.found) process.env.SECHEUR_KNOWLEDGE_BASE_ENABLED = "1";
	const permission = takeOption(knowledgeBase.args, ["--permission-mode", "--permissionMode"]);
	if (permission.missingValue) {
		console.error(`${permission.missingValue} requires a value`);
		process.exitCode = 2;
		return;
	}
	if (permission.value !== undefined) {
		if (!VALID_PERMISSION_MODES.has(permission.value as PermissionMode)) {
			console.error(`Invalid permission mode: ${permission.value}`);
			process.exitCode = 2;
			return;
		}
		process.env.SECHEUR_PERMISSION_MODE = permission.value;
	}
	if (permission.args[0] === "competition") {
		await runCompetitionCli(permission.args.slice(1));
		return;
	}

	const config = loadSecHeurConfig({
		projectRoot: process.env.SECHEUR_PROJECT_ROOT ?? process.env.INIT_CWD ?? process.cwd(),
	});
	const command = permission.args[0];
	if (permission.args[0] === "doctor" || permission.args.includes("--doctor")) {
		const diagnostic = inspectLegacyEnvironment(config);
		console.log(formatLegacyEnvironmentReport(diagnostic));
		if (!diagnostic.ready) process.exitCode = 1;
		return;
	}
	if (command === "self-test" || permission.args.includes("--self-test")) {
		const jsonOutput = permission.args.includes("--json");
		const report = await runIsolatedSelfTest({
			projectRoot: process.env.SECHEUR_PROJECT_ROOT ?? process.env.INIT_CWD ?? process.cwd(),
			env: process.env,
		});
		console.log(jsonOutput ? formatSelfTestJson(report) : formatSelfTestText(report));
		if (!report.ok) process.exitCode = 1;
		return;
	}
	if (command === "planning-self-test") {
		const report = await runPlanningSelfTest();
		console.log(
			permission.args.includes("--json")
				? JSON.stringify(report, null, 2)
				: `Progressive planning self-test: ${report.ok ? "ok" : "failed"} (${report.status}, ${report.taskCount} tasks)`,
		);
		if (!report.ok) process.exitCode = 1;
		return;
	}
	if (command === "list") {
		printCommands();
		return;
	}
	if (command === "status") {
		await printStatus(process.env);
		return;
	}
	if (command === "launch" || command === "bridge") {
		await runBridge(config, process.env);
		return;
	}
	if (command === "solver") {
		await runSolver(permission.args.slice(1), process.env);
		return;
	}
	process.env.PI_CODING_AGENT_DIR = config.agentDir;
	process.env.SECHEUR_CONFIG_DIR = config.stateDir;
	process.chdir(config.projectRoot);
	process.title = "secheur-agent";

	const piArgs = command === "cli" ? permission.args.slice(1) : permission.args;
	const startsMainHost = !piArgs.includes("--help") && !piArgs.includes("-h") && !piArgs.includes("--list-models");
	if (!startsMainHost) {
		const extension = createSecHeurExtensionFactory({ config });
		await main(piSessionArgs(piArgs, config), {
			extensionFactories: [extension],
			skillsOverride: (base) => filterEnabledSkills(config, base),
			configureSession: (session) => {
				attachSecHeurSessionPolicy(session, config);
				attachProgressivePlanningController(session, {
					config,
					cwd: config.projectRoot,
					createExtensionBundle() {
						const child = createSecHeurExtension({
							config,
							permissionMode: "dontAsk",
							env: process.env,
							subAgentDepth: 1,
							allowKnowledgeBaseRetrieval: session.getAllTools().some((tool) => tool.name === "attack_memory_search"),
							registerInactiveKnowledgeBaseTool: true,
							reloadKnowledgeBaseConfigBeforePrompt: true,
						});
						return planningExecutorExtensionBundle(child.extension, () => child.state.close(), [
							repoAuditExtension,
						]);
					},
				});
			},
		});
		return;
	}

	const controller = await MainAgentController.open({ config, env: process.env });
	let host: PiSessionHost | undefined;
	let extensionState: SecHeurExtensionState | undefined;
	try {
		const extension = createSecHeurExtensionFactory({
			config,
			competitionCoordinator: controller.coordinator,
			mainWorkflow: controller,
			onState: (state) => {
				extensionState = state;
			},
		});
		await main(piSessionArgs(piArgs, config), {
			extensionFactories: [extension],
			skillsOverride: (base) => filterEnabledSkills(config, base),
			configureSession: (session) => {
				attachSecHeurSessionPolicy(session, config);
				attachProgressivePlanningController(session, {
					config,
					cwd: config.projectRoot,
					outerTaskId: "main-agent",
					createExtensionBundle() {
						const child = createSecHeurExtension({
							config,
							permissionMode: "dontAsk",
							env: process.env,
							subAgentDepth: 1,
							allowKnowledgeBaseRetrieval: session.getAllTools().some((tool) => tool.name === "attack_memory_search"),
							registerInactiveKnowledgeBaseTool: true,
							reloadKnowledgeBaseConfigBeforePrompt: true,
							competitionCoordinator: controller.coordinator,
							mainWorkflow: controller,
						});
						return planningExecutorExtensionBundle(child.extension, () => child.state.close(), [
							repoAuditExtension,
						]);
					},
				});
			},
			onRuntimeReady: async (runtime) => {
				runtime.session.setSessionName("Main Agent");
				controller.attachMainSession(runtime.session.sessionId);
				host = new PiSessionHost(runtime, {
					stateDir: config.stateDir,
					role: "main",
					title: "Main Agent",
					...(extensionState ? { permissionController: extensionState.permissions } : {}),
				});
				await host.start();
			},
		});
	} finally {
		await host?.close();
		await controller.close();
	}
}

void mainCli(process.argv.slice(2)).catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
