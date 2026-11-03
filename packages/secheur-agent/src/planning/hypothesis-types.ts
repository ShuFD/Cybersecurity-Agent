import type { PlanningArtifact } from "./contracts.ts";
import type { EvidenceCard, EvidenceCardInput } from "./evidence-cards.ts";

export type { EvidenceCard } from "./evidence-cards.ts";
export type HypothesisStatus = "pending" | "testing" | "undetermined" | "verified" | "refuted";
export interface HypothesisNode {
	id: string;
	statement: string;
	status: HypothesisStatus;
	basisRefs: string[];
	parentHypothesisIds: string[];
	verificationCriteria: string;
	refutationCriteria: string;
	verificationEvidenceRefs: string[];
	needsReview: boolean;
}

export interface HypothesisInputRequirement {
	sourceTaskId: string;
	artifactPath?: string;
	evidenceId?: string;
}
export interface HypothesisTaskBinding {
	taskId: string;
	hypothesisIds: string[];
	purpose: "test_hypothesis" | "gather_evidence" | "verify_goal" | "review_basis";
	requiredInputs: HypothesisInputRequirement[];
}
export interface HypothesisGraph {
	version: number;
	nodes: HypothesisNode[];
	cards: EvidenceCard[];
	taskBindings: HypothesisTaskBinding[];
	checkpointArtifacts?: Pick<PlanningArtifact, "sourceTaskId" | "path" | "sha256" | "logicalPath" | "sourceLeaseId">[];
}
export interface HypothesisGraphUpdate {
	expectedVersion: number;
	newNodes: HypothesisNode[];
	newBindings: HypothesisTaskBinding[];
}
export interface HypothesisObservation {
	expectedVersion: number;
	card: EvidenceCardInput;
	resolutions: {
		hypothesisId: string;
		verdict: "verified" | "refuted" | "undetermined";
		explanation: string;
		evidenceRefs: string[];
		reviewOfEvidenceRefs?: string[];
	}[];
}
