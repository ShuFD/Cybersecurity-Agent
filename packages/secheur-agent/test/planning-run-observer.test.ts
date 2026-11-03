import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { type ObserverSuggestion, PlanRunObserver, type RunObserverOptions } from "../src/planning/run-observer.ts";

function suggestion(version = 1): ObserverSuggestion {
	return {
		runId: "synthetic",
		baseVersion: version,
		notes: [
			{
				kind: "failure_boundary",
				topic: "one input",
				text: "One input failed; the larger hypothesis remains open.",
				evidenceIds: ["proof"],
			},
		],
		reminders: [
			{ topic: "repeat", text: "Use the saved observation before repeating this input", evidenceIds: ["proof"] },
		],
		corrections: [],
	};
}
function fixture(mode: "report" | "guidance", overrides: Partial<RunObserverOptions> = {}) {
	const root = mkdtempSync(join(tmpdir(), "run-observer-"));
	const observer = new PlanRunObserver({
		stateDir: root,
		runId: "synthetic",
		mode,
		snapshot: () => ({ runId: "synthetic", version: 1, evidenceIds: ["proof"], context: {} }),
		observe: async () => suggestion(),
		...overrides,
	});
	return {
		root,
		observer,
		cleanup() {
			observer.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
it("observes both executors without waiting for the model or occupying an execution slot", async () => {
	let finish!: (value: ObserverSuggestion) => void;
	const observe = vi.fn(
		() =>
			new Promise<ObserverSuggestion>((resolve) => {
				finish = resolve;
			}),
	);
	const f = fixture("report", { observe });
	try {
		for (let i = 0; i < 6; i++) f.observer.recordTurn(i % 2 ? "b" : "a", { round: i });
		await Promise.resolve();
		expect(observe).toHaveBeenCalledOnce();
		for (let i = 6; i < 30; i++) f.observer.recordTurn(i % 2 ? "b" : "a", { round: i });
		expect(observe).toHaveBeenCalledOnce();
		finish(suggestion());
		await f.observer.waitForIdle();
		expect(f.observer.overview()).toEqual([]);
		expect(f.observer.takeReminders("a")).toEqual([]);
		const directory = join(
			f.root,
			"planning",
			"run-observer",
			readdirSync(join(f.root, "planning", "run-observer"))[0],
		);
		expect(readFileSync(join(directory, "suggestions.jsonl"), "utf8")).toContain("One input failed");
	} finally {
		f.cleanup();
	}
});
it("rejects stale, foreign and unsupported suggestions without changing notes or invalidating facts", () => {
	const applyCorrection = vi.fn();
	const f = fixture("guidance", { applyCorrection });
	try {
		expect(f.observer.apply(suggestion(0))).toBe(false);
		expect(f.observer.apply({ ...suggestion(), runId: "other" })).toBe(false);
		expect(
			f.observer.apply({
				...suggestion(),
				corrections: [{ factId: "a", replacementFactId: "b", evidenceIds: ["proof"] }],
			}),
		).toBe(false);
		expect(
			f.observer.apply({ ...suggestion(), notes: [{ ...suggestion().notes[0], evidenceIds: ["other-run"] }] }),
		).toBe(false);
		expect(applyCorrection).not.toHaveBeenCalled();
		expect(f.observer.overview()).toEqual([]);
	} finally {
		f.cleanup();
	}
});
it("merges the same topic, preserves original observations and deduplicates reminders for twelve turns", async () => {
	const f = fixture("guidance");
	try {
		for (let i = 0; i < 6; i++) f.observer.recordTurn(i % 2 ? "b" : "a", { round: i });
		await f.observer.waitForIdle();
		expect(f.observer.takeReminders("a")).toHaveLength(1);
		for (let i = 0; i < 6; i++) f.observer.recordTurn("a", { round: i + 6 });
		await f.observer.waitForIdle();
		expect(f.observer.takeReminders("a")).toHaveLength(0);
		expect(f.observer.overview()).toHaveLength(1);
		for (let i = 0; i < 6; i++) f.observer.recordTurn("a", { round: i + 12 });
		await f.observer.waitForIdle();
		expect(f.observer.takeReminders("a")).toHaveLength(1);
	} finally {
		f.cleanup();
	}
});
it("applies only host-proved corrections through the supplied existing interface", () => {
	const applyCorrection = vi.fn();
	const f = fixture("guidance", {
		validateCorrection: (c) => c.factId === "wrong" && c.replacementFactId === "proven",
		applyCorrection,
	});
	try {
		const correction = { factId: "wrong", replacementFactId: "proven", evidenceIds: ["proof"] };
		expect(f.observer.apply({ ...suggestion(), corrections: [correction] })).toBe(true);
		expect(applyCorrection).toHaveBeenCalledExactlyOnceWith(correction);
	} finally {
		f.cleanup();
	}
});
it("keeps immutable cited advice across appended observations but rejects removed evidence at delivery", async () => {
	let version = 1;
	let evidenceIds = ["proof"];
	const f = fixture("guidance", {
		snapshot: () => ({ runId: "synthetic", version, evidenceIds, context: {} }),
	});
	try {
		for (let turn = 0; turn < 6; turn++) f.observer.recordTurn("a", { turn });
		await f.observer.waitForIdle();
		version++;
		evidenceIds = ["proof", "new-observation"];
		expect(f.observer.takeReminders("a")).toHaveLength(1);
		evidenceIds = ["new-observation"];
		expect(f.observer.takeReminders("b")).toEqual([]);
	} finally {
		f.cleanup();
	}
});

it("validates an asynchronous source frontier after evidence append without accepting stale corrections", async () => {
	let version = 1;
	let finish!: (value: ObserverSuggestion) => void;
	const event = vi.fn();
	const f = fixture("guidance", { onEvent: event,
		snapshot: () => ({ runId: "synthetic", version, evidenceIds: ["proof", ...(version > 1 ? ["new"] : [])], context: {} }),
		observe: () => new Promise(resolve => { finish = resolve; }),
	});
	try {
		for (let turn = 0; turn < 6; turn++) f.observer.recordTurn(turn % 2 ? "a" : "b", { turn });
		await Promise.resolve();
		version = 2;
		finish(suggestion(1));
		await f.observer.waitForIdle();
		expect(f.observer.overview()).toHaveLength(1);
		expect(f.observer.apply({ ...suggestion(1), sourceEvidenceIds: ["proof"], corrections: [{ factId: "old", replacementFactId: "new", evidenceIds: ["proof"] }] })).toBe(false);
	} finally { f.cleanup(); }
});
it("records each actual correction and does not claim notes applied after a later host write fails", () => {
	const event = vi.fn();
	const applyCorrection = vi.fn((correction) => {
		if (correction.factId === "second") throw new Error("host write failed");
	});
	const f = fixture("guidance", { onEvent: event, validateCorrection: () => true, applyCorrection });
	try {
		expect(
			f.observer.apply({
				...suggestion(),
				corrections: [
					{ factId: "first", replacementFactId: "one", evidenceIds: ["proof"] },
					{ factId: "second", replacementFactId: "two", evidenceIds: ["proof"] },
				],
			}),
		).toBe(false);
		expect(f.observer.overview()).toEqual([]);
		expect(event.mock.calls.some(([type]) => type === "observer_suggestion_applied")).toBe(false);
		const directory = join(
			f.root,
			"planning",
			"run-observer",
			readdirSync(join(f.root, "planning", "run-observer"))[0]!,
		);
		const records = readFileSync(join(directory, "corrections.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ status: "host_applied", correction: { factId: "first" } });
	} finally {
		f.cleanup();
	}
});
