interface BlackboardSession {
	id: string;
	title: string;
	status: string;
	createdAt: number;
	updatedAt: number;
	messageRecords: Array<Record<string, unknown>>;
	partial: Record<string, unknown> | null;
}

const TAG = /<[^>]+>/gu;
const WHITESPACE = /\s+/gu;
const LLM_RUNNING = /\**LLM Running \(Turn \d+\) \.\.\.\**/giu;
const CODE_FENCE = /`{3,}[\s\S]*?`{3,}/gu;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u;

export function stripGoalPlanBlocks(value: string): string {
	return value.replace(/<!--\s*secheur:goal-plan\s*-->[\s\S]*?<!--\s*\/secheur:goal-plan\s*-->/giu, "").trim();
}

function stripMarkdown(value: string): string {
	return value
		.replace(/!\[([^\]]*)\]\([^)]+\)/gu, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
		.replace(/`([^`]+)`/gu, "$1")
		.replace(/(^|\s)[*_]{1,3}([^*_]+)[*_]{1,3}(\s|$)/gu, "$1$2$3")
		.replaceAll("**", "")
		.replaceAll("__", "")
		.replaceAll("`", "");
}

function cleanText(value: unknown, fallback: string): string {
	const text = stripMarkdown(
		stripGoalPlanBlocks(String(value ?? ""))
			.replace(/<think>[\s\S]*?<\/think>/giu, " ")
			.replace(/<summary>\s*([\s\S]*?)\s*<\/summary>/giu, "$1")
			.replace(TAG, " "),
	)
		.replace(WHITESPACE, " ")
		.trim();
	return text || fallback;
}

function removeInternalLines(value: string): string {
	return value
		.split(/\r?\n/u)
		.filter((line) => {
			const text = line.trim();
			if (!text) return true;
			return !(
				/^\**LLM Running \(Turn \d+\) \.\.\.\**$/iu.test(text) ||
				TABLE_RULE.test(text) ||
				/^(?:🛠️\s*)?Tool\s*:/iu.test(text) ||
				/^(?:📥\s*)?args\s*:/iu.test(text) ||
				/^\[(?:Action|Status|Stdout|Stderr|Info|omitted)\b/iu.test(text) ||
				text.startsWith("``")
			);
		})
		.join("\n");
}

function cleanAssistantCandidate(value: string): string {
	return stripMarkdown(
		removeInternalLines(
			value
				.replace(/<summary>[\s\S]*?<\/summary>/giu, " ")
				.replace(/<think>[\s\S]*?<\/think>/giu, " ")
				.replace(/<function_calls\b[^>]*>[\s\S]*?<\/function_calls>/giu, " ")
				.replace(/<function_results\b[^>]*>[\s\S]*?<\/function_results>/giu, " ")
				.replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/giu, " ")
				.replace(/<result\b[^>]*>[\s\S]*?<\/result>/giu, " ")
				.replace(CODE_FENCE, " ")
				.replace(/`{3,}[\s\S]*$/u, " "),
		).replace(TAG, " "),
	)
		.replace(/[ \t]+/gu, " ")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}

function assistantText(value: unknown, fallback: string): string {
	const raw = stripGoalPlanBlocks(String(value ?? ""));
	if (!raw) return fallback;
	const parts = raw.split(LLM_RUNNING);
	for (let index = parts.length - 1; index >= (parts.length > 1 ? 1 : 0); index -= 1) {
		const candidate = cleanAssistantCandidate(parts[index]);
		if (candidate) return candidate;
	}
	return cleanAssistantCandidate(raw) || fallback;
}

function summary(value: unknown, fallback: string, limit: number, assistant = false): string {
	const text = (assistant ? assistantText(value, fallback) : cleanText(value, fallback))
		.replace(WHITESPACE, " ")
		.trim();
	return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function timestamp(message: Record<string, unknown>, fallback: number): number {
	const value = Number(message.ts ?? 0);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function intentStatus(message: Record<string, unknown>): "running" | "failed" | "concluded" {
	if (message.partial) return "running";
	if (message.role === "error") return "failed";
	if (message.role === "permission" && message.status !== "resolved" && message.status !== "done") return "running";
	return "concluded";
}

export function buildSessionBlackboardGraph(session: BlackboardSession): Record<string, unknown> {
	const messages = [...session.messageRecords];
	if (session.partial) messages.push({ ...session.partial, partial: true });
	const firstUser = messages.find((message) => message.role === "user");
	const origin = summary(firstUser?.content, "等待用户目标", 240);
	const goal = firstUser ? `完成用户目标：${origin}` : "等待明确目标";
	const facts: Array<Record<string, unknown>> = [
		{
			id: "origin",
			description: origin,
			sourceMessageId: firstUser?.id ?? null,
			createdAt: timestamp(firstUser ?? {}, session.createdAt),
			kind: "origin",
		},
		{
			id: "goal",
			description: goal,
			sourceMessageId: firstUser?.id ?? null,
			createdAt: timestamp(firstUser ?? {}, session.createdAt),
			kind: "goal",
		},
	];
	const intents: Array<Record<string, unknown>> = [];
	const hints: Array<Record<string, unknown>> = [];
	let lastFactId = "origin";
	let factIndex = 1;
	let intentIndex = 1;
	let firstUserSeen = false;
	for (const message of messages) {
		const role = message.role;
		const createdAt = timestamp(message, session.createdAt);
		if (role === "user") {
			if (!firstUserSeen) {
				firstUserSeen = true;
				continue;
			}
			hints.push({
				id: `h${String(hints.length + 1).padStart(3, "0")}`,
				content: summary(message.content, "用户补充", 220),
				creator: message.source ?? "user",
				sourceMessageId: message.id ?? null,
				createdAt,
			});
			continue;
		}
		if (role === "permission") {
			const status = intentStatus(message);
			intents.push({
				id: `i${String(intentIndex++).padStart(3, "0")}`,
				from: [lastFactId],
				to: null,
				description: summary(message.title ?? message.content, "权限确认", 180),
				creator: "desktop.permission",
				worker: message.tool_name ?? message.toolName ?? "permission",
				status,
				sourceMessageId: message.id ?? null,
				createdAt,
				concludedAt: status === "concluded" ? createdAt : null,
			});
			continue;
		}
		if (role !== "assistant" && role !== "error" && role !== "system") continue;
		const content = summary(
			message.content,
			message.partial ? "Agent 正在探索" : "Agent 产出结果",
			260,
			role === "assistant",
		);
		const status = intentStatus(message);
		const intentId = `i${String(intentIndex++).padStart(3, "0")}`;
		if (status === "running") {
			intents.push({
				id: intentId,
				from: [lastFactId],
				to: null,
				description: content,
				creator: "secheur.agent",
				worker: "SecHeur Agent",
				status,
				sourceMessageId: message.id ?? null,
				createdAt,
				concludedAt: null,
			});
			continue;
		}
		const factId = `f${String(factIndex++).padStart(3, "0")}`;
		facts.push({
			id: factId,
			description: content,
			sourceMessageId: message.id ?? null,
			createdAt,
			kind: role === "error" ? "error" : role === "system" ? "system" : "fact",
		});
		intents.push({
			id: intentId,
			from: [lastFactId],
			to: factId,
			description: role === "assistant" ? "记录 Agent 已确认结果" : "记录运行状态",
			creator: "secheur.agent",
			worker: "SecHeur Agent",
			status,
			sourceMessageId: message.id ?? null,
			createdAt,
			concludedAt: createdAt,
		});
		lastFactId = factId;
	}
	return {
		project: {
			id: session.id,
			title: session.title,
			status: session.status,
			origin,
			goal,
			reason:
				session.status === "running"
					? {
							worker: "SecHeur Agent",
							trigger: "active_turn",
							startedAt: session.partial?.ts ?? session.updatedAt,
						}
					: null,
		},
		facts,
		intents,
		hints,
		summary: {
			factCount: facts.length,
			intentCount: intents.length,
			hintCount: hints.length,
			runningIntentCount: intents.filter((intent) => intent.status === "running").length,
			openIntentCount: intents.filter((intent) => !intent.to).length,
		},
	};
}
