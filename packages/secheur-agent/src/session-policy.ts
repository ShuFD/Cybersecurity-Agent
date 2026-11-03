import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SecHeurConfig } from "./config.ts";
import type { OperationalGuard } from "./operational-guard.ts";

export type SecHeurBudgetStopReason = "maxTurns" | "maxCost" | "verifier_quota_exhausted";

export interface SecHeurBudgetStatus {
	maxTurns: number | null;
	maxCost?: number;
	turnsUsed: number;
	cost: number;
	stopped: boolean;
	reason?: SecHeurBudgetStopReason;
	message?: string;
}

export interface SecHeurSessionPolicy {
	beginPrompt(): void;
	recordExternalTurn(cost: number): void;
	getBudgetStatus(): SecHeurBudgetStatus;
	dispose(): void;
}

function thinkingLevelForBudget(budget: number): ThinkingLevel {
	if (budget <= 1_024) return "minimal";
	if (budget <= 2_048) return "low";
	if (budget <= 8_192) return "medium";
	return "high";
}

export function resolveSecHeurThinkingLevel(
	config: SecHeurConfig,
	fallback?: ThinkingLevel,
): ThinkingLevel | undefined {
	if (config.thinkingMode === "disabled") return "off";
	if (config.thinkingMode !== "enabled") return fallback;
	return thinkingLevelForBudget(config.thinkingBudget ?? 4_096);
}

export function attachSecHeurSessionPolicy(
	session: AgentSession,
	config: SecHeurConfig,
	hasPendingCommands: () => boolean = () => false,
	onBudgetStop: () => void = () => {},
	operationalGuard?: OperationalGuard,
): SecHeurSessionPolicy {
	const thinkingBudget = config.thinkingMode === "enabled" ? (config.thinkingBudget ?? 4_096) : undefined;
	const thinkingLevel = resolveSecHeurThinkingLevel(config, session.thinkingLevel);
	if (thinkingLevel !== undefined) session.setThinkingLevel(thinkingLevel);
	if (thinkingBudget !== undefined) {
		session.agent.thinkingBudgets = {
			minimal: thinkingBudget,
			low: thinkingBudget,
			medium: thinkingBudget,
			high: thinkingBudget,
		};
	}

	let turnsUsed = operationalGuard?.turnsUsed ?? 0;
	let budgetStopReason: SecHeurBudgetStopReason | undefined;
	let budgetMessage: string | undefined;
	let budgetNotified = false;
	let promptActive = false;
	let lastObservedCost = session.getSessionStats().cost;
	let costUsed = Math.max(operationalGuard?.costUsed ?? 0, lastObservedCost);
	const currentCost = () => {
		const cost = session.getSessionStats().cost;
		costUsed += Math.max(0, cost - lastObservedCost);
		lastObservedCost = cost;
		if (operationalGuard && costUsed !== operationalGuard.costUsed) operationalGuard.setCostUsed(costUsed);
		return costUsed;
	};

	const beginPrompt = () => {
		turnsUsed = operationalGuard?.turnsUsed ?? 0;
		budgetStopReason = undefined;
		budgetMessage = undefined;
		budgetNotified = false;
	};

	const evaluateBudget = (cost: number) => {
		const previous = budgetStopReason;
		if (operationalGuard?.verificationState === "quota_exhausted") {
			budgetStopReason = "verifier_quota_exhausted";
			budgetMessage = "Verification quota exhausted; no new planning, execution or recovery requests are permitted.";
		} else if (config.maxCost !== undefined && cost >= config.maxCost) {
			budgetStopReason = "maxCost";
			budgetMessage = `[Budget] Cost limit reached: ${cost.toFixed(4)} >= ${config.maxCost.toFixed(4)}.`;
		} else if (config.maxTurns !== undefined && turnsUsed >= config.maxTurns) {
			budgetStopReason = "maxTurns";
			budgetMessage = `[Budget] Turn limit reached: ${turnsUsed}/${config.maxTurns}.`;
		}
		if (budgetStopReason !== undefined && previous !== budgetStopReason) {
			session.clearQueue();
			onBudgetStop();
		}
	};
	const inheritedShouldStopAfterTurn = session.agent.shouldStopAfterTurn;
	const shouldStopAfterTurn: NonNullable<typeof session.agent.shouldStopAfterTurn> = async (context, signal) => {
		turnsUsed = (operationalGuard?.turnsUsed ?? turnsUsed) + 1;
		operationalGuard?.setTurnsUsed(turnsUsed);
		const inheritedStop = (await inheritedShouldStopAfterTurn?.(context, signal)) ?? false;
		const cost = currentCost();
		evaluateBudget(cost);
		return inheritedStop || budgetStopReason !== undefined;
	};
	session.agent.shouldStopAfterTurn = shouldStopAfterTurn;

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "agent_start") {
			if (!promptActive) beginPrompt();
			promptActive = true;
			return;
		}
		if (event.type === "thinking_level_changed" && config.thinkingMode === "disabled" && event.level !== "off") {
			session.setThinkingLevel("off");
			return;
		}
		if (event.type !== "agent_settled") return;
		currentCost();
		promptActive = hasPendingCommands();
		if (!budgetMessage || !budgetStopReason || budgetNotified) return;
		budgetNotified = true;
		void session
			.sendCustomMessage({
				customType: "secheur-budget",
				content: budgetMessage,
				display: true,
				details: { reason: budgetStopReason, ...session.getSessionStats() },
			})
			.catch(() => undefined);
	});

	return {
		beginPrompt,
		recordExternalTurn(cost) {
			promptActive = true;
			turnsUsed = (operationalGuard?.turnsUsed ?? turnsUsed) + 1;
			operationalGuard?.setTurnsUsed(turnsUsed);
			costUsed = (operationalGuard?.costUsed ?? costUsed) + Math.max(0, cost);
			operationalGuard?.setCostUsed(costUsed);
			evaluateBudget(costUsed);
		},
		getBudgetStatus() {
			evaluateBudget(currentCost());
			return {
				maxTurns: config.maxTurns ?? null,
				...(config.maxCost === undefined ? {} : { maxCost: config.maxCost }),
				turnsUsed,
				cost: currentCost(),
				stopped: budgetStopReason !== undefined,
				...(budgetStopReason === undefined ? {} : { reason: budgetStopReason }),
				...(budgetMessage === undefined ? {} : { message: budgetMessage }),
			};
		},
		dispose() {
			unsubscribe();
			if (session.agent.shouldStopAfterTurn === shouldStopAfterTurn) {
				session.agent.shouldStopAfterTurn = inheritedShouldStopAfterTurn;
			}
		},
	};
}
