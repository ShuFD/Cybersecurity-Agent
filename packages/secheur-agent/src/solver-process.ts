import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { PiClient } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import type { ModelRef, ThinkingLevel } from "@earendil-works/pi-protocol";
import { CompetitionCoordinatorBinding } from "./competition-solver.ts";
import type { CompetitionTaskRecord } from "./competition-store.ts";
import type { SecHeurConfig } from "./config.ts";
import { listSessionRegistrations, type PiSessionRegistration } from "./session-registry.ts";
import { buildSolverPrompt, type WorklistOrchestrator } from "./worklist.ts";

const execFile = promisify(execFileCallback);
const SOLVER_EXCLUDED_ENV_KEYS = [
	"SLAB_AGENT_ACCESSKEY",
	"SLAB_MATCH_HOST",
	"SLAB_MATCH_ID",
	"CTFD_API_TOKEN",
	"CTFD_URL",
	"CTFD_AGENT_API_URL",
	"CTFD_AGENT_ACCESS_KEY",
	"CTFD_AGENT_USER_ID",
	"CTFD_AGENT_GATEWAY_URL",
	"CTF_LAB_TOKEN",
	"CTF_LAB_URL",
	"CTF_LAB_GATEWAY_URL",
	"BIGMODEL_API_KEY",
	"BIGMODEL_RESPONSES_ENDPOINT",
] as const;

export interface DispatchSolverInput {
	taskId: string;
	prompt: string;
	title?: string;
	/** The model selected by the Main Agent when dispatching this solver. */
	model?: ModelRef;
	/** Keep the solver's thinking setting aligned with the Main Agent. */
	thinkingLevel?: ThinkingLevel;
}

export interface SolverProcessManagerOptions {
	config: SecHeurConfig;
	env: NodeJS.ProcessEnv;
	worklist: WorklistOrchestrator;
	mainSessionId: string;
}

interface SolverProcess {
	taskId: string;
	solverId: string;
	tmuxTarget: string;
	promptFile: string;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function removeSolverSecrets(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const result = { ...environment };
	for (const key of SOLVER_EXCLUDED_ENV_KEYS) delete result[key];
	return result;
}

function restrictSolverCommand(command: string, agentDir: string): string {
	const unset = SOLVER_EXCLUDED_ENV_KEYS.map((key) => `-u ${key}`).join(" ");
	const assignments = [
		`PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`,
		`SECHEUR_AGENT_DIR=${shellQuote(agentDir)}`,
	].join(" ");
	// BSD env (used by macOS) does not accept the GNU-style `--` separator.
	return `env ${unset} ${assignments} sh -c ${shellQuote(command)}`;
}

function shortName(value: string, fallback: string): string {
	const normalized = value
		.replace(/[^A-Za-z0-9_.-]+/gu, "-")
		.replace(/^-+|-+$/gu, "")
		.slice(0, 42);
	return normalized || fallback;
}

function solverTitle(task: CompetitionTaskRecord, requestedTitle?: string): string {
	const category = task.challenge.category.trim();
	const name = requestedTitle?.trim() || task.challenge.name.trim() || task.shortTask.trim() || task.taskId;
	if (!category || name.toLowerCase().includes(category.toLowerCase())) return name;
	return `${category} - ${name}`;
}

function solverModelArguments(model: ModelRef | undefined, thinkingLevel: ThinkingLevel | undefined): string[] {
	if (!model) return thinkingLevel ? ["--thinking", thinkingLevel] : [];
	const provider = model.provider.trim();
	const id = model.id.trim();
	if (!provider || !id) throw new Error("Solver model provider and id are required");
	return ["--provider", provider, "--model", id, ...(thinkingLevel ? ["--thinking", thinkingLevel] : [])];
}

function effectiveAgentDir(config: SecHeurConfig, environment: NodeJS.ProcessEnv): string {
	// The coding-agent runtime resolves its catalog from PI_CODING_AGENT_DIR. Main
	// may set it after SecHeur config loading, so preserve that effective path for
	// solver children instead of silently switching to stateDir/pi.
	return environment.PI_CODING_AGENT_DIR?.trim() || environment.SECHEUR_AGENT_DIR?.trim() || config.agentDir;
}

export class TmuxSolverProcessManager {
	private readonly config: SecHeurConfig;
	private readonly env: NodeJS.ProcessEnv;
	private readonly solverEnv: NodeJS.ProcessEnv;
	private readonly solverAgentDir: string;
	private readonly worklist: WorklistOrchestrator;
	private readonly mainSessionId: string;
	private readonly processes = new Map<string, SolverProcess>();

	constructor(options: SolverProcessManagerOptions) {
		this.config = options.config;
		this.env = options.env;
		// Main and solver must resolve the same model catalog and auth storage. The
		// CLI normally sets both variables, but the manager is also used directly by
		// tests and embedding applications where the parent environment may omit them.
		const agentDir = effectiveAgentDir(options.config, options.env);
		this.solverAgentDir = agentDir;
		this.solverEnv = {
			...removeSolverSecrets(options.env),
			PI_CODING_AGENT_DIR: agentDir,
			SECHEUR_AGENT_DIR: agentDir,
		};
		this.worklist = options.worklist;
		this.mainSessionId = options.mainSessionId;
	}

	async dispatch(input: DispatchSolverInput): Promise<Record<string, unknown>> {
		if (this.processes.has(input.taskId)) throw new Error(`Solver already dispatched for task ${input.taskId}`);
		const coordinator = new CompetitionCoordinatorBinding({
			socketPath: this.worklist.competitionSocket,
			clientId: `dispatch:${this.mainSessionId}`,
		});
		try {
			const tasks = await coordinator.listTasks();
			let task = tasks.find((candidate) => candidate.taskId === input.taskId);
			if (!task) throw new Error(`Competition task not found: ${input.taskId}`);
			if (task.status === "stopped") {
				await coordinator.requeueTasks([input.taskId], "Explicit solver dispatch requested by Main Agent");
				task = (await coordinator.listTasks()).find((candidate) => candidate.taskId === input.taskId);
				if (!task) throw new Error(`Competition task disappeared while requeuing: ${input.taskId}`);
			}
			if (!(task.status === "queued" || task.status === "environment_blocked")) {
				throw new Error(`Competition task is not dispatchable: ${input.taskId} (${task.status})`);
			}
			if (task.attemptBudget === undefined)
				throw new Error(`Attempt budget is required before dispatch: ${input.taskId}`);
			let item = this.worklist.findItemForCompetitionTask(input.taskId);
			if (!item) {
				await this.worklist.refresh();
				item = this.worklist.findItemForCompetitionTask(input.taskId);
			}
			if (!item) throw new Error(`Worklist item is not prepared for competition task: ${input.taskId}`);
			const prepared = await this.worklist.prepareTaskForSolver(item.id);
			const taskPrompt = buildSolverPrompt(prepared.details, prepared.item.workdir, this.mainSessionId, []);
			const directive = input.prompt.trim().slice(0, 40_000);
			if (!directive) throw new Error("Solver prompt must not be empty");
			const prompt = `${taskPrompt}\n\nMain Agent directive:\n${directive}`;
			const solverId = `solver:${input.taskId}:${randomUUID()}`;
			const title = solverTitle(task, input.title);
			const windowName = `solver-${shortName(title, "task")}-${shortName(solverId.slice(-8), "run")}`;
			const promptDirectory = join(this.config.stateDir, "solver-prompts");
			await mkdir(promptDirectory, { recursive: true, mode: 0o700 });
			const promptFile = join(promptDirectory, `${shortName(solverId, "solver")}.txt`);
			await writeFile(promptFile, prompt, { mode: 0o600 });
			await chmod(promptFile, 0o600);

			const cliPath = process.argv[1];
			if (!cliPath) throw new Error("Cannot locate secheur CLI entrypoint for tmux solver");
			const command = [
				process.execPath,
				cliPath,
				"solver",
				"--task-id",
				input.taskId,
				"--solver-id",
				solverId,
				"--competition-socket",
				this.worklist.competitionSocket,
				"--state-dir",
				this.config.stateDir,
				"--project-root",
				this.config.projectRoot,
				"--cwd",
				prepared.item.workdir,
				"--prompt-file",
				promptFile,
				"--name",
				title,
				"--category",
				task.challenge.category,
				"--main-session-id",
				this.mainSessionId,
				...solverModelArguments(input.model, input.thinkingLevel),
			]
				.map(shellQuote)
				.join(" ");
			const tmuxTarget = await this.resolveTmuxTarget(windowName);
			const commandWithTarget = restrictSolverCommand(
				`${command} --tmux-target ${shellQuote(tmuxTarget)}`,
				this.solverAgentDir,
			);
			await this.createTmuxWindow(windowName, commandWithTarget, tmuxTarget);
			this.processes.set(input.taskId, { taskId: input.taskId, solverId, tmuxTarget, promptFile });
			return {
				taskId: input.taskId,
				solverId,
				title,
				tmuxTarget,
				workdir: prepared.item.workdir,
				status: "starting",
				...(input.model ? { provider: input.model.provider.trim(), model: input.model.id.trim() } : {}),
				...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
			};
		} finally {
			coordinator.close();
		}
	}

	async list(): Promise<PiSessionRegistration[]> {
		return listSessionRegistrations(this.config.stateDir, { pruneStale: true });
	}

	async guide(taskId: string, message: string): Promise<Record<string, unknown>> {
		const registration = await this.findRegistration(taskId);
		if (!registration) return { taskId, delivered: false, status: "pending" };
		const client = await PiClient.connect({
			transportFactory: createUnixTransportFactory({ path: registration.socketPath }),
		});
		try {
			const lease = await client.attachSession(registration.sessionId);
			try {
				const snapshot = lease.snapshot;
				if (snapshot?.phase === "idle") await lease.prompt(`[Main Agent guidance]\n${message.trim()}`);
				else await lease.steer(`[Main Agent guidance]\n${message.trim()}`);
			} finally {
				await lease.dispose();
			}
		} finally {
			await client.dispose();
		}
		return { taskId, delivered: true, sessionId: registration.sessionId };
	}

	async stop(taskId: string): Promise<Record<string, unknown>> {
		const process = this.processes.get(taskId);
		const registration = process ? undefined : await this.findRegistration(taskId);
		const tmuxTarget = process?.tmuxTarget ?? registration?.tmuxTarget;
		if (tmuxTarget) {
			await this.killTmuxTarget(tmuxTarget).catch(() => undefined);
			this.processes.delete(taskId);
		}
		return { taskId, stopped: true, tmuxTarget: tmuxTarget ?? null };
	}

	async close(): Promise<void> {
		await Promise.all([...this.processes.keys()].map((taskId) => this.stop(taskId)));
	}

	private async findRegistration(taskId: string): Promise<PiSessionRegistration | undefined> {
		return (await this.list()).find(
			(registration) => registration.role === "solver" && registration.taskId === taskId,
		);
	}

	private async resolveTmuxTarget(windowName: string): Promise<string> {
		const inTmux = Boolean(this.env.TMUX);
		if (inTmux) {
			const session = (
				await execFile("tmux", ["display-message", "-p", "#S"], { env: this.solverEnv })
			).stdout.trim();
			return `${session}:${windowName}`;
		}
		const session = `secheur-${process.pid}-${shortName(basename(windowName), "solver")}`;
		return `${session}:${windowName}`;
	}

	private async createTmuxWindow(windowName: string, command: string, tmuxTarget: string): Promise<void> {
		if (this.env.TMUX) {
			await execFile("tmux", ["new-window", "-d", "-n", windowName, command], { env: this.solverEnv });
			return;
		}
		const session = tmuxTarget.slice(0, tmuxTarget.lastIndexOf(":"));
		await execFile("tmux", ["new-session", "-d", "-s", session, "-n", windowName, command], { env: this.solverEnv });
	}

	private async killTmuxTarget(target: string): Promise<void> {
		await execFile("tmux", ["kill-window", "-t", target], { env: this.solverEnv });
	}
}
