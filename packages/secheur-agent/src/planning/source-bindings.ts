import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface ObservationSource {
	runId: string;
	evidenceId: string;
	value: unknown;
	sourceHash: string;
	outcome: "tool_error" | "observation";
}
export interface SourceBinding {
	bindingId: string;
	runId: string;
	evidenceId: string;
	jsonPointer: string;
	sourceHash: string;
	value: unknown;
	authority: "original_observation";
	outcome: ObservationSource["outcome"];
}
function atPointer(value: unknown, pointer: string): unknown {
	if (pointer === "") return value;
	if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer)) throw new Error("Use a valid JSON pointer");
	for (const segment of pointer.slice(1).split("/")) {
		const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
		if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
			throw new Error("Source field does not exist");
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}
function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Values are derived by the host from original same-run records, never filled from model memory. */
export class PlanningSourceBindings {
	private readonly records = new Map<string, SourceBinding>();
	private readonly path: string;
	private readonly runId: string;
	private readonly read: (evidenceId: string) => ObservationSource;
	constructor(stateDir: string, runId: string, read: (evidenceId: string) => ObservationSource) {
		this.runId = runId;
		this.read = read;
		const directory = join(stateDir, "planning", "source-bindings");
		mkdirSync(directory, { recursive: true });
		this.path = join(directory, digest(runId) + ".jsonl");
		if (existsSync(this.path))
			for (const line of readFileSync(this.path, "utf8").split("\n").filter(Boolean)) {
				const record = JSON.parse(line) as SourceBinding;
				if (record.runId !== runId || record.authority !== "original_observation")
					throw new Error("Source binding ownership mismatch");
				this.records.set(record.bindingId, record);
			}
	}
	bind(evidenceId: string, jsonPointer: string): SourceBinding {
		const source = this.read(evidenceId);
		if (source.runId !== this.runId || source.evidenceId !== evidenceId)
			throw new Error("Observation belongs to another run");
		const value = atPointer(source.value, jsonPointer);
		if (JSON.stringify(value).length > 16384)
			throw new Error("Bind a smaller source field; original evidence stays queryable");
		const bindingId = "source_" + digest([this.runId, evidenceId, source.sourceHash, jsonPointer]).slice(0, 24);
		const record: SourceBinding = {
			bindingId,
			runId: this.runId,
			evidenceId,
			jsonPointer,
			sourceHash: source.sourceHash,
			value,
			authority: "original_observation",
			outcome: source.outcome,
		};
		if (!this.records.has(bindingId)) {
			appendFileSync(this.path, JSON.stringify(record) + "\n", { mode: 0o600 });
			this.records.set(bindingId, record);
		}
		return structuredClone(record);
	}
	list(): SourceBinding[] {
		return structuredClone([...this.records.values()]);
	}
	/** Deliberately narrow: semantic contradictions remain questions. Only literal bound-value errors can be proved automatically. */
	provesCorrection(oldStatement: string, replacementStatement: string, evidenceIds: string[]): boolean {
		try {
			const old = JSON.parse(oldStatement) as { bindingId?: string; value?: unknown };
			const replacement = JSON.parse(replacementStatement) as { bindingId?: string; value?: unknown };
			if (!old.bindingId || replacement.bindingId !== old.bindingId) return false;
			const binding = this.records.get(old.bindingId);
			if (!binding || binding.outcome !== "observation" || !evidenceIds.includes(binding.evidenceId)) return false;
			const source = this.read(binding.evidenceId);
			return (
				source.runId === this.runId &&
				source.sourceHash === binding.sourceHash &&
				digest(atPointer(source.value, binding.jsonPointer)) === digest(replacement.value) &&
				digest(old.value) !== digest(replacement.value)
			);
		} catch {
			return false;
		}
	}
	extension(): InlineExtension {
		return {
			name: "same-run-source-bindings",
			factory: (pi) => {
				pi.registerTool({
					name: "planning_bind_observation",
					label: "Bind original source value",
					description:
						"Bind a parameter, version, content or dynamic value to a JSON pointer in original same-run tool evidence. This records an observation, not a hypothesis or verified answer.",
					parameters: Type.Object({ evidenceId: Type.String(), jsonPointer: Type.String() }),
					execute: async (_id, args) => {
						const binding = this.bind(args.evidenceId, args.jsonPointer);
						return { content: [{ type: "text", text: JSON.stringify(binding) }], details: binding };
					},
				});
			},
		};
	}
}
