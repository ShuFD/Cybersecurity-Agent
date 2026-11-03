/** Regression tests ported from CairnPilot b015733 (Apache-2.0). */

import { afterEach, describe, expect, test, vi } from "vitest";
import { cairnTestIO } from "./fixtures/cairn-test-io.ts";

const mock = vi.fn;

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGraphHostBridgeHandler } from "../src/planning/cairn/host-bridge-handler.ts";
import type { HostBridgeHandleContext } from "../src/planning/cairn/host-types.ts";
import { GraphService } from "../src/planning/cairn/service.ts";
import { GraphStore } from "../src/planning/cairn/store.ts";

const createdDirectories: string[] = [];

function context(
	params: Record<string, unknown>,
	overrides: Partial<HostBridgeHandleContext> = {},
): HostBridgeHandleContext {
	return {
		solverId: "solver-a",
		requestId: "request-a",
		toolCallId: "tool-a",
		action: "fact_propose",
		params,
		getSolverEnvValue: () => undefined,
		getSolver: () => ({
			id: "solver-a",
			challengeId: "challenge-a",
			status: "running",
			promptName: "p",
			task: "",
			containerId: "c",
			name: "s",
			createdAt: 0,
		}),
		...overrides,
	};
}

afterEach(async () => {
	await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Graph Host Bridge", () => {
	test("separates repeated call IDs across Solvers and Intent attempts while preserving replay checks", async () => {
		const store = new GraphStore(":memory:");
		store.initialize();
		const handler = createGraphHostBridgeHandler(new GraphService(store), { intentSessionEnabled: true });
		try {
			const make = (solverId: string, intentId: string, generation: number, sessionEpoch: number) =>
				context(
					{
						createdAt: "2026-10-04T00:00:00.000Z",
						kind: "fact",
						statement: `${intentId}:${generation}`,
						confidence: 0.8,
					},
					{
						solverId,
						toolCallId: "call_1",
						getSolver: () => ({ id: solverId, challengeId: "challenge-a" }),
						intentSession: { challengeId: "challenge-a", intentId, generation, sessionEpoch },
						isCurrentIntentSession: () => true,
					},
				);
			const firstContext = make("solver-a", "intent-a", 1, 1);
			const first = await handler.handle(firstContext);
			expect(await handler.handle(firstContext)).toEqual(first);
			const otherSolver = await handler.handle(make("solver-b", "intent-a", 1, 1));
			const switched = await handler.handle(make("solver-a", "intent-b", 1, 2));
			const retry = await handler.handle(make("solver-a", "intent-b", 2, 3));
			const ids = [first, otherSolver, switched, retry].map((item) => (item.data as { id: string }).id);
			expect(new Set(ids).size).toBe(4);
			await expect(
				handler.handle({ ...firstContext, params: { ...(firstContext.params as object), statement: "conflict" } }),
			).rejects.toMatchObject({ type: "conflict" });
		} finally {
			store.close();
		}
	});
	test("rejects missing and stale Intent session tags before any Graph write", async () => {
		const proposeFact = mock(() => ({ id: "candidate-a" }));
		const handler = createGraphHostBridgeHandler({ proposeFact } as unknown as GraphService, {
			intentSessionEnabled: true,
		});
		const params = { createdAt: "2026-06-14T00:00:00.000Z", kind: "fact", statement: "reachable", confidence: 0.8 };
		await expect(handler.handle(context(params, { isCurrentIntentSession: () => false }))).rejects.toMatchObject({
			type: "forbidden",
		});
		await expect(
			handler.handle(
				context(params, {
					intentSession: { challengeId: "challenge-a", intentId: "old", generation: 1, sessionEpoch: 1 },
					isCurrentIntentSession: () => false,
				}),
			),
		).rejects.toMatchObject({ type: "forbidden" });
		expect(proposeFact).not.toHaveBeenCalled();
	});

	test("derives Challenge from Solver and uses request/tool call IDs for idempotency", async () => {
		const proposeFact = mock(() => ({ id: "candidate-a" }));
		const handler = createGraphHostBridgeHandler({ proposeFact } as unknown as GraphService);

		await handler.handle(
			context({
				createdAt: "2026-06-14T00:00:00.000Z",
				kind: "fact",
				statement: "reachable",
				confidence: 0.8,
			}),
		);

		expect(proposeFact).toHaveBeenCalledWith(
			expect.objectContaining({
				actor: { id: "solver-a", role: "solver", challengeId: "challenge-a" },
				idempotencyKey: JSON.stringify(["fact_propose", "solver-a", null, null, null, "tool-a"]),
			}),
		);
	});

	test("rejects a request that claims another Challenge and rejects unknown fields", async () => {
		const handler = createGraphHostBridgeHandler({ proposeFact: mock(() => ({})) } as unknown as GraphService);
		const base = {
			createdAt: "2026-06-14T00:00:00.000Z",
			kind: "fact",
			statement: "reachable",
			confidence: 0.8,
		};

		await expect(handler.handle(context({ ...base, challengeId: "challenge-b" }))).rejects.toMatchObject({
			type: "forbidden",
		});
		await expect(handler.handle(context({ ...base, extra: true }))).rejects.toMatchObject({ type: "validation" });
	});

	test("does not expose Fact invalidation to Solver requests", async () => {
		const invalidateFact = mock(() => ({}));
		const handler = createGraphHostBridgeHandler({ invalidateFact } as unknown as GraphService);

		const result = await handler.handle(
			context(
				{ createdAt: "2026-06-14T00:00:00.000Z", factId: "fact-a", replacementFactId: "fact-b" },
				{ action: "fact_invalidate" as never },
			),
		);

		expect(result).toEqual({ handled: false });
		expect(invalidateFact).not.toHaveBeenCalled();
	});

	test("validates Context limits as safe integers before delegation", async () => {
		const getFocusedContext = mock(() => ({}));
		const handler = createGraphHostBridgeHandler({ getFocusedContext } as unknown as GraphService);

		await expect(handler.handle(context({ maxFacts: 1.5 }, { action: "graph_get_context" }))).rejects.toMatchObject({
			type: "validation",
		});
		expect(getFocusedContext).not.toHaveBeenCalled();
	});

	test("copies an Artifact from the bound Solver workspace into Host-managed storage", async () => {
		const directory = await mkdtemp(join(tmpdir(), "cairnpilot-graph-host-bridge-"));
		createdDirectories.push(directory);
		const workspace = join(directory, "workspace");
		await mkdir(join(workspace, "reports"), { recursive: true });
		await cairnTestIO.write(join(workspace, "reports", "result.txt"), "host managed");
		const store = new GraphStore(join(directory, "graph.db"));
		store.initialize();
		const service = new GraphService(store, { artifactRoot: join(directory, "challenges") });
		const handler = createGraphHostBridgeHandler(service);
		const sha256 = createHash("sha256").update("host managed").digest("hex");

		const result = await handler.handle(
			context(
				{
					createdAt: "2026-06-14T00:00:00.000Z",
					relativePath: "reports/result.txt",
					sha256,
					size: 12,
					mimeType: "text/plain",
				},
				{
					action: "artifact_register",
					getSolverWorkspacePath: () => workspace,
				},
			),
		);

		expect(result.handled).toBe(true);
		expect(result.data as { solverId: string; challengeId: string; path: string }).toMatchObject({
			solverId: "solver-a",
			challengeId: "challenge-a",
			path: "reports/result.txt",
		});
		expect(
			await cairnTestIO
				.file(join(directory, "challenges", "challenge-a", "artifacts", "reports", "result.txt"))
				.text(),
		).toBe("host managed");
		store.close();
	});

	test("uses only the trusted Runtime Lease binding for Intent writes", async () => {
		const checkpointIntent = mock(() => ({ intentId: "intent-a", version: 4, resultFactIds: [] }));
		const updateIntentLeaseBinding = mock(() => {});
		const service = { checkpointIntent } as unknown as GraphService;
		const disabled = createGraphHostBridgeHandler(service);
		expect(await disabled.handle(context({}, { action: "intent_checkpoint" }))).toEqual({ handled: false });

		const handler = createGraphHostBridgeHandler(service, { leaseEnabled: true });
		const result = await handler.handle(
			context(
				{ factIds: [] },
				{
					action: "intent_checkpoint",
					getIntentLeaseBinding: () => ({
						challengeId: "challenge-a",
						intentId: "intent-a",
						solverId: "solver-a",
						token: "trusted-token",
						generation: 2,
						leaseUntil: "2026-06-15T00:01:00.000Z",
						version: 3,
					}),
					updateIntentLeaseBinding,
				},
			),
		);

		expect(result.handled).toBe(true);
		expect(checkpointIntent).toHaveBeenCalledWith(
			expect.objectContaining({
				actor: { id: "solver-a", role: "solver", challengeId: "challenge-a" },
				intentId: "intent-a",
				token: "trusted-token",
				generation: 2,
				expectedVersion: 3,
				idempotencyKey: JSON.stringify(["intent_checkpoint", "solver-a", "intent-a", 2, null, "tool-a"]),
			}),
		);
		expect(updateIntentLeaseBinding).toHaveBeenCalledWith(expect.objectContaining({ version: 4 }));

		await expect(
			handler.handle(
				context(
					{ factIds: [] },
					{
						action: "intent_checkpoint",
						getIntentLeaseBinding: () => undefined,
					},
				),
			),
		).rejects.toMatchObject({ type: "forbidden" });
	});
});
