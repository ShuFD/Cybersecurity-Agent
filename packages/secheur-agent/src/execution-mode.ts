/**
 * The execution mode is resolved once at the runtime boundary.  Planning's
 * historical `off`/`shadow`/`active` values are kept as compatibility input,
 * but downstream code consumes this contract instead of inferring a mode from
 * individual planning flags.
 */
export type ExecutionMode = "direct" | "plan_single" | "plan_multi";

export type LegacyPlanningMode = "off" | "shadow" | "active";

export interface ExecutionModeSpec {
	mode: ExecutionMode;
	planningEnabled: boolean;
	capacity: number;
	/** Historical behavior retained while the public mode is normalized. */
	legacyPlanningMode: LegacyPlanningMode;
}

export interface ResolveExecutionModeInput {
	/** Explicit mode from a runtime/request or a new config field. */
	mode?: unknown;
	/** Existing planning.mode value, including legacy off/shadow/active. */
	legacyPlanningMode?: unknown;
	/** Optional boolean compatibility input for callers without planning.mode. */
	planningEnabled?: unknown;
	/** Capacity is a parameter of the selected mode, never the mode selector. */
	capacity?: unknown;
}

export class ExecutionModeResolutionError extends Error {
	readonly source = "execution_mode" as const;
	readonly stage = "mode_resolution" as const;
	readonly code = "invalid_execution_mode" as const;

	constructor(message: string) {
		super(message);
		this.name = "ExecutionModeResolutionError";
	}
}

function normalizedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase().replaceAll("-", "_");
	return normalized || undefined;
}

function executionModeValue(value: unknown): ExecutionMode | undefined {
	const normalized = normalizedString(value);
	if (normalized === "direct" || normalized === "plan_single" || normalized === "plan_multi") return normalized;
	return undefined;
}

function legacyPlanningModeValue(value: unknown): LegacyPlanningMode | undefined {
	const normalized = normalizedString(value);
	if (normalized === "off" || normalized === "shadow" || normalized === "active") return normalized;
	return undefined;
}

function hasValue(value: unknown): boolean {
	return value !== undefined && value !== null && value !== "";
}

function capacityValue(value: unknown, fallback: number): number {
	if (!hasValue(value)) return fallback;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new ExecutionModeResolutionError(`invalid execution capacity: ${String(value)}`);
	}
	return parsed;
}

function booleanValue(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

function invalidMode(value: unknown): never {
	throw new ExecutionModeResolutionError(`invalid execution mode: ${String(value)}`);
}

/**
 * Resolve explicit and legacy inputs into the one runtime mode contract.
 *
 * `shadow` remains a serial Planning compatibility variant: it is exposed as
 * PLAN_SINGLE with capacity 1 while the controller retains its historical
 * direct-executor behavior.  This keeps existing configurations stable without
 * creating a fourth public execution mode.
 */
export function resolveExecutionMode(input: ResolveExecutionModeInput = {}): ExecutionModeSpec {
	const explicitInput = input.mode;
	const hasExplicitMode = hasValue(explicitInput);
	const explicit = hasValue(explicitInput) ? executionModeValue(explicitInput) : undefined;
	if (hasValue(explicitInput) && !explicit) invalidMode(explicitInput);

	const legacyInput = input.legacyPlanningMode;
	const legacy = hasValue(legacyInput) ? legacyPlanningModeValue(legacyInput) : undefined;
	const legacyAsExecutionMode = hasValue(legacyInput) ? executionModeValue(legacyInput) : undefined;
	if (hasValue(legacyInput) && !legacy && !legacyAsExecutionMode && !hasExplicitMode) invalidMode(legacyInput);
	const planningEnabled = booleanValue(input.planningEnabled);

	const selected = explicit ?? legacyAsExecutionMode;
	if (selected) {
		if (selected === "direct") {
			const capacity = capacityValue(input.capacity, 1);
			if (capacity !== 1) throw new ExecutionModeResolutionError("DIRECT requires capacity 1");
			return { mode: "direct", planningEnabled: false, capacity: 1, legacyPlanningMode: "off" };
		}
		if (selected === "plan_single") {
			// An explicit first-class mode wins over legacy compatibility values. A
			// legacy-only `shadow` config is the sole case that retains shadow's
			// historical direct-executor behavior.
			const selectedLegacy = !hasExplicitMode && legacy === "shadow" ? "shadow" : "active";
			const capacity = capacityValue(input.capacity, 1);
			if (capacity !== 1) throw new ExecutionModeResolutionError("PLAN_SINGLE requires capacity 1");
			return { mode: "plan_single", planningEnabled: true, capacity: 1, legacyPlanningMode: selectedLegacy };
		}
		const capacity = capacityValue(input.capacity, 2);
		return { mode: "plan_multi", planningEnabled: true, capacity, legacyPlanningMode: "active" };
	}

	if (legacy === "off" || planningEnabled === false) {
		const capacity = capacityValue(input.capacity, 1);
		if (capacity !== 1) throw new ExecutionModeResolutionError("DIRECT requires capacity 1");
		return { mode: "direct", planningEnabled: false, capacity: 1, legacyPlanningMode: "off" };
	}
	if (legacy === "shadow") {
		const capacity = capacityValue(input.capacity, 1);
		if (capacity !== 1) throw new ExecutionModeResolutionError("PLAN_SINGLE requires capacity 1");
		return { mode: "plan_single", planningEnabled: true, capacity: 1, legacyPlanningMode: "shadow" };
	}
	if (legacy === "active" || planningEnabled === true) {
		const capacity = capacityValue(input.capacity, 1);
		if (capacity !== 1) throw new ExecutionModeResolutionError("PLAN_SINGLE requires capacity 1");
		return { mode: "plan_single", planningEnabled: true, capacity: 1, legacyPlanningMode: "active" };
	}
	const capacity = capacityValue(input.capacity, 1);
	if (capacity !== 1) throw new ExecutionModeResolutionError("DIRECT requires capacity 1");
	return { mode: "direct", planningEnabled: false, capacity: 1, legacyPlanningMode: "off" };
}
