export type ArtexNodeKind = "goal" | "intent" | "fact" | "finding" | "hint" | "digest";
export type ArtexRelation = "spawns" | "derived_from" | "yields" | "proves" | "covers";
export type ArtexState =
	| "open"
	| "running"
	| "paused"
	| "done"
	| "blocked"
	| "exhausted"
	| "stopped"
	| "deleted"
	| "origin"
	| "confirmed"
	| "met"
	| "abandoned";

export interface ArtexNode {
	id: string;
	kind: ArtexNodeKind;
	payload: string;
	state: ArtexState;
	priority: number;
	origin: "host" | "planner" | "worker";
	owner?: string;
	blockedReason?: string;
	deleteReason?: string;
	anchors: string[];
	evidenceRefs: string[];
	sourceTaskId?: string;
	sourceLeaseId?: string;
	inherited: boolean;
	confidence?: "observed" | "inferred";
	observationHash?: string;
	createdAt: number;
	createdRound: number;
	lastActiveRound: number;
}

export interface ArtexEdge {
	source: string;
	target: string;
	relation: ArtexRelation;
}

export interface ArtexAsset {
	id: string;
	type: string;
	label: string;
	evidenceRefs: string[];
	sourceTaskId: string;
}

export interface ArtexGraph {
	schemaVersion: 1;
	runId: string;
	version: number;
	round: number;
	nodes: ArtexNode[];
	edges: ArtexEdge[];
	assets: ArtexAsset[];
	assetEdges: { source: string; target: string; relation: string; evidenceRefs: string[] }[];
	todo: string;
}

export interface ArtexPlanUpdate {
	expectedRound: number;
	observedVersion: number;
	todo: string;
	intents: { taskId: string; parentIds: string[]; anchors: string[] }[];
	hints: { key: string; payload: string; parentIds: string[]; evidenceRefs: string[] }[];
}

export interface ArtexObservation {
	key: string;
	kind: "fact" | "finding";
	payload: string;
	confidence: "observed" | "inferred";
	evidenceRefs: string[];
	parentIds?: string[];
	anchors?: string[];
	assets?: { key: string; type: string; label: string }[];
	assetEdges?: { source: string; target: string; relation: string }[];
}
