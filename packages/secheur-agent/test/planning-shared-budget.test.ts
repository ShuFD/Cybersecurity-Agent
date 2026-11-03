import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { loadSecHeurConfig } from "../src/config.ts";
import { OperationalGuard } from "../src/operational-guard.ts";
import { attachSecHeurSessionPolicy } from "../src/session-policy.ts";

describe("shared outer planning budget", () => {
	it("shares verification termination without treating a reserved final request as failure", () => {
		const root = mkdtempSync(join(tmpdir(), "planning-quota-"));
		const guard = new OperationalGuard(root, "quota");
		const session = {
			agent: {},
			thinkingLevel: "off",
			setThinkingLevel: () => {},
			clearQueue: vi.fn(),
			subscribe: () => () => {},
			getSessionStats: () => ({ cost: 0 }),
		} as unknown as AgentSession;
		const config = loadSecHeurConfig({ projectRoot: root, env: {} });
		config.maxTurns = 220;
		const policy = attachSecHeurSessionPolicy(session, config, undefined, undefined, guard);
		try {
			for (let i = 0; i < 3; i++) {
				guard.observe("bash", {}, `proof-${i}`, false);
				guard.reserveVerification(`candidate-${i}`);
			}
			expect(policy.getBudgetStatus().stopped).toBe(false);
			for (let i = 0; i < 3; i++) guard.settleVerification(`candidate-${i}`, "incorrect");
			expect(policy.getBudgetStatus()).toMatchObject({
				stopped: true,
				reason: "verifier_quota_exhausted",
				turnsUsed: 0,
			});
			expect(session.clearQueue).toHaveBeenCalledOnce();
			expect(policy.getBudgetStatus().reason).toBe("verifier_quota_exhausted");
			expect(session.clearQueue).toHaveBeenCalledOnce();
		} finally {
			policy.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("charges supervisor and sibling turns to the same durable outer budget", () => {
		const root = mkdtempSync(join(tmpdir(), "planning-budget-"));
		const guard = new OperationalGuard(root, "fixture");
		let sessionCost = 0;
		const stop = vi.fn();
		const session = {
			agent: {},
			thinkingLevel: "off",
			setThinkingLevel: () => {},
			clearQueue: vi.fn(),
			subscribe: () => () => {},
			getSessionStats: () => ({ cost: sessionCost }),
		} as unknown as AgentSession;
		const config = loadSecHeurConfig({ projectRoot: root, env: {} });
		config.maxTurns = 3;
		config.maxCost = undefined;
		const policy = attachSecHeurSessionPolicy(session, config, undefined, stop, guard);
		try {
			policy.recordExternalTurn(0.1);
			policy.recordExternalTurn(0.2);
			expect(policy.getBudgetStatus()).toMatchObject({ turnsUsed: 2, stopped: false });
			expect(policy.getBudgetStatus().cost).toBeCloseTo(0.3);
			policy.recordExternalTurn(0.1);
			expect(policy.getBudgetStatus()).toMatchObject({ turnsUsed: 3, stopped: true, reason: "maxTurns" });
			expect(stop).toHaveBeenCalledOnce();
			expect(new OperationalGuard(root, "fixture").turnsUsed).toBe(3);
			sessionCost = 0.5;
			expect(policy.getBudgetStatus().cost).toBeCloseTo(0.9);
			// Compaction removes transcript statistics, never the accumulated ledger.
			sessionCost = 0;
			expect(policy.getBudgetStatus().cost).toBeCloseTo(0.9);
		} finally {
			policy.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("charges model costs even for planning parents without an operational ledger", () => {
		const root = mkdtempSync(join(tmpdir(), "planning-budget-"));
		const session = {
			agent: {},
			thinkingLevel: "off",
			setThinkingLevel: () => {},
			clearQueue: () => {},
			subscribe: () => () => {},
			getSessionStats: () => ({ cost: 0 }),
		} as unknown as AgentSession;
		const config = loadSecHeurConfig({ projectRoot: root, env: {} });
		config.maxTurns = undefined;
		config.maxCost = 0.5;
		const policy = attachSecHeurSessionPolicy(session, config);
		try {
			policy.recordExternalTurn(0.3);
			policy.recordExternalTurn(0.3);
			expect(policy.getBudgetStatus()).toMatchObject({ turnsUsed: 2, stopped: true, reason: "maxCost", cost: 0.6 });
		} finally {
			policy.dispose();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
