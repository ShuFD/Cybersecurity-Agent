import { describe, expect, it } from "vitest";
import {
	COMPETITION_PROTOCOL,
	COMPETITION_PROTOCOL_VERSION,
	CompetitionProtocolError,
	formatFlagCandidate,
	parseCompetitionEvent,
	parseCompetitionRpcRequest,
	parseFlagFormat,
} from "../src/competition-protocol.ts";

describe("competition protocol", () => {
	it("rejects unknown fields and unsupported versions", () => {
		const event = {
			protocol: COMPETITION_PROTOCOL,
			version: COMPETITION_PROTOCOL_VERSION,
			eventId: "event-1",
			taskId: "task-1",
			assignmentId: "assignment-1",
			solverId: "solver-1",
			type: "evidence",
			occurredAt: Date.now(),
			payload: {
				evidenceId: "evidence-1",
				kind: "observation",
				summary: "The service exposes a banner.",
				source: "terminal",
				refs: ["terminal:1"],
			},
		} as Record<string, unknown>;

		expect(() => parseCompetitionEvent({ ...event, extra: true })).toThrowError(CompetitionProtocolError);
		expect(() => parseCompetitionEvent({ ...event, version: 999 })).toThrowError(
			/unsupported competition protocol version/iu,
		);
		expect(() =>
			parseCompetitionEvent({ ...event, payload: { ...(event.payload as Record<string, unknown>), confidence: 2 } }),
		).toThrowError(/between 0 and 1/iu);
	});

	it("normalizes wrapper modes without hard-coding a platform", () => {
		const format = parseFlagFormat({ prefix: "FLAG{", suffix: "}", accepts: "either", submit: "inner" });
		expect(formatFlagCandidate("FLAG{secret}", format)).toEqual({ normalized: "secret", submitted: "secret" });
		expect(formatFlagCandidate("secret", format)).toEqual({ normalized: "secret", submitted: "secret" });
		expect(() => formatFlagCandidate("secret", { ...format, accepts: "full" })).toThrowError(/wrapper is required/iu);
		expect(() => formatFlagCandidate("FLAG{secret}", { ...format, accepts: "inner" })).toThrowError(
			/wrapper is not accepted/iu,
		);
		expect(formatFlagCandidate("raw-answer", { prefix: "", suffix: "", accepts: "full", submit: "full" })).toEqual({
			normalized: "raw-answer",
			submitted: "raw-answer",
		});
	});

	it("accepts runtime adapter configuration without allowing unknown fields", () => {
		const request = {
			protocol: COMPETITION_PROTOCOL,
			version: COMPETITION_PROTOCOL_VERSION,
			type: "command",
			requestId: "configure-1",
			operation: "configure_adapter",
			payload: {
				platform: "ctfd",
				transport: "agent_api",
				baseUrl: "http://127.0.0.1:18000",
				accessKeyEnv: "CTFD_AGENT_ACCESS_KEY",
				useEnvironmentCredentials: true,
			},
		};
		const parsed = parseCompetitionRpcRequest(request);
		expect(parsed).toMatchObject({ operation: "configure_adapter", payload: request.payload });
		expect(() => parseCompetitionRpcRequest({ ...request, payload: { ...request.payload, secret: "nope" } })).toThrow(
			CompetitionProtocolError,
		);
	});

	it("validates an explicit batch requeue command", () => {
		const request = {
			protocol: COMPETITION_PROTOCOL,
			version: COMPETITION_PROTOCOL_VERSION,
			type: "command",
			requestId: "requeue-1",
			operation: "requeue_tasks",
			payload: { taskIds: ["ctfd:1", "ctfd:2"], reason: "resume after restart" },
		};
		expect(parseCompetitionRpcRequest(request)).toMatchObject({
			operation: "requeue_tasks",
			payload: request.payload,
		});
		expect(() => parseCompetitionRpcRequest({ ...request, payload: { taskIds: [], reason: "resume" } })).toThrow(
			/must not be empty/iu,
		);
		expect(() => parseCompetitionRpcRequest({ ...request, payload: { taskIds: ["ctfd:1"], extra: true } })).toThrow(
			CompetitionProtocolError,
		);
	});
});
