import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	CompetitionChallenge,
	CompetitionPlatformAdapter,
	CompetitionPolicy,
} from "../src/competition-adapters.ts";
import { CompetitionBroker } from "../src/competition-broker.ts";
import { CompetitionBrokerServer } from "../src/competition-protocol-service.ts";
import { CompetitionStore } from "../src/competition-store.ts";
import { loadSecHeurConfig } from "../src/config.ts";
import { TmuxSolverProcessManager } from "../src/solver-process.ts";
import { openWorklistOrchestrator } from "../src/worklist.ts";
import { WorklistStore } from "../src/worklist-store.ts";

function challenge(exerciseId: number): CompetitionChallenge {
	return {
		exerciseId,
		name: `fake-${exerciseId}`,
		category: "misc",
		description: "fake challenge",
		hints: [],
		flagFormat: { prefix: "FLAG{", suffix: "}", accepts: "either", submit: "full" },
		attachments: [],
		environment: { required: false, status: "none", endpoints: [] },
		scoring: {
			currentScore: 1,
			challengeValue: 1,
			estimatedSolveProbability: 1,
			confidence: 0,
			expectedRemainingMinutes: 1,
			environmentWaitMinutes: 0,
			agingBonus: 0,
			asOf: Date.now(),
		},
		platform: {},
		isOpen: true,
		hasSolved: false,
	};
}

describe.runIf(process.platform !== "win32")("solver process model handoff", () => {
	it("passes the Main model and agent directory to the tmux solver", async () => {
		const root = await mkdtemp(join(tmpdir(), "secheur-solver-process-"));
		const stateDir = join(root, "state");
		const workRoot = join(root, "work");
		const socketPath = join(stateDir, "competition.sock");
		const binDir = join(root, "bin");
		const tmuxLog = join(root, "tmux.log");
		const tmuxEnvLog = join(root, "tmux-env.log");
		const tmuxPath = join(binDir, "tmux");
		await mkdir(binDir, { recursive: true });
		await writeFile(
			tmuxPath,
			'#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$TMUX_LOG"\nprintf \'%s\\n\' "$PI_CODING_AGENT_DIR" > "$TMUX_ENV_LOG"\n',
		);
		await chmod(tmuxPath, 0o755);
		const testEnv: NodeJS.ProcessEnv = {
			...process.env,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			TMUX_LOG: tmuxLog,
			TMUX_ENV_LOG: tmuxEnvLog,
			SECHEUR_CONFIG_DIR: stateDir,
			SECHEUR_AGENT_DIR: join(root, "config-agent"),
			PI_CODING_AGENT_DIR: join(root, "effective-agent"),
			SECHEUR_PROJECT_ROOT: root,
		};
		delete testEnv.TMUX;

		const adapter: CompetitionPlatformAdapter = {
			platform: "ctfd",
			getPolicy: async (): Promise<CompetitionPolicy> => ({
				flagFormat: challenge(1).flagFormat,
				submission: {
					flagFormat: challenge(1).flagFormat,
					maxAttempts: 1,
					duplicateScope: "challenge",
					acceptedStatuses: ["correct"],
				},
				maxEnvironmentSlots: 1,
				raw: {},
			}),
			listChallenges: async () => [
				{ exerciseId: 1, name: "fake-1", category: "misc", isOpen: true, hasSolved: false, score: 1, raw: {} },
			],
			getChallenge: async (exerciseId) => challenge(Number(exerciseId)),
			startEnvironment: async () => ({ status: "ready", endpoints: [], leaseMetadata: {}, raw: {} }),
			getEnvironment: async () => ({ status: "ready", endpoints: [], leaseMetadata: {}, raw: {} }),
			submitFlag: async () => ({ isCorrect: false, requestPayload: {}, rawResponse: {} }),
			releaseEnvironment: async () => ({}),
		};
		const store = await CompetitionStore.open(join(stateDir, "competition.sqlite"));
		const broker = CompetitionBroker.from({ store, adapter, ownerId: "solver-process-test" });
		const server = new CompetitionBrokerServer({ broker, socketPath });
		const config = loadSecHeurConfig({ projectRoot: root, stateDir, env: testEnv });
		const worklistStore = await WorklistStore.open(join(stateDir, "worklist.sqlite"));
		const orchestrator = await openWorklistOrchestrator({
			config,
			env: testEnv,
			store: worklistStore,
			competitionBroker: broker,
			competitionServer: server,
			competitionSocketPath: socketPath,
			mode: "main",
			workRoot,
		});
		const previousCliPath = process.argv[1];
		let manager: TmuxSolverProcessManager | undefined;
		try {
			await orchestrator.start();
			await orchestrator.refresh();
			broker.setAttemptBudgets([{ taskId: "ctfd:1", budget: 1 }]);
			process.argv[1] = join(root, "secheur-cli-fake.mjs");
			manager = new TmuxSolverProcessManager({
				config,
				env: testEnv,
				worklist: orchestrator,
				mainSessionId: "main-test",
			});
			const result = await manager.dispatch({
				taskId: "ctfd:1",
				prompt: "Use the inherited model.",
				model: { provider: "custom", id: "MiniMax-M3" },
				thinkingLevel: "off",
			});

			expect(result).toMatchObject({ provider: "custom", model: "MiniMax-M3", thinkingLevel: "off" });
			const command = await readFile(tmuxLog, "utf8");
			expect(command).toMatch(/--provider[\s\S]*custom[\s\S]*--model[\s\S]*MiniMax-M3[\s\S]*--thinking[\s\S]*off/u);
			expect(command).toContain(`PI_CODING_AGENT_DIR='${join(root, "effective-agent")}'`);
			expect(command).toContain(`SECHEUR_AGENT_DIR='${join(root, "effective-agent")}'`);
			expect(await readFile(tmuxEnvLog, "utf8")).toBe(`${join(root, "effective-agent")}\n`);
		} finally {
			process.argv[1] = previousCliPath;
			await manager?.close();
			await orchestrator.close();
			await server.close();
			await broker.close();
			store.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});
