import { delimiter, dirname } from "node:path";
import { createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type BackgroundCommands, commandSeconds } from "./background-commands.ts";

export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
export const MAX_COMMAND_TIMEOUT_SECONDS = 600;
export const COMMAND_BUDGET_GUIDANCE =
	"Foreground wait defaults to 120 seconds (maximum 600); exceeding it moves the command to background without killing it. " +
	"run_in_background=true returns immediately; its timeout controls execution (default 1800 seconds, maximum 7200). " +
	"Auto-background jobs get 1800 seconds after transition. Completion is delivered automatically; continue independent work. " +
	"Use command_task_output or command_task_stop with the returned task_id. Parent run budgets still apply.";

export function boundedCommandTimeout(timeout: unknown): number {
	return commandSeconds(timeout);
}

const parameters = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Foreground wait seconds (default 120, max 600); background execution seconds (default 1800, max 7200)",
		}),
	),
	run_in_background: Type.Optional(Type.Boolean()),
});
export function createBoundedCtfBashTool(
	cwd: string,
	tasks: BackgroundCommands,
	pythonExecutable?: string,
): ToolDefinition<typeof parameters> {
	const tool = createBashToolDefinition(cwd, {
		spawnHook: (context) => ({
			...context,
			env: {
				...context.env,
				...(pythonExecutable
					? {
							PATH: `${dirname(pythonExecutable)}${delimiter}${context.env.PATH ?? ""}`,
							VIRTUAL_ENV: dirname(dirname(pythonExecutable)),
							SECHEUR_PYTHON_EXECUTABLE: pythonExecutable,
						}
					: {}),
			},
		}),
	});
	return {
		name: tool.name,
		label: tool.label,
		description: `${tool.description} ${COMMAND_BUDGET_GUIDANCE}`,
		parameters,
		async execute(id, input, signal, onUpdate, ctx) {
			return tasks.run(
				"bash",
				input,
				signal,
				(jobSignal, update) => tool.execute(id, { command: input.command }, jobSignal, update, ctx),
				onUpdate,
			);
		},
	};
}
