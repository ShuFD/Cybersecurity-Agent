import type { IntentLease, IntentSessionTag } from "./types.ts";

/** In-process replacement for Cairn's Docker HostBridge transport. */
export interface HostBridgeHandleContext {
	action: string;
	params: unknown;
	solverId: string;
	requestId: string;
	toolCallId?: string;
	intentSession?: IntentSessionTag;
	getSolver?: () => { id: string; challengeId?: string };
	getSolverEnvValue(name: string): string | undefined;
	getSolverWorkspacePath?: () => string;
	getIntentLeaseBinding?: () => IntentLease | undefined;
	updateIntentLeaseBinding?: (lease: IntentLease) => void;
	stopIntentLease?: () => void;
	finishIntentSession?: (reusable: boolean) => void;
	isCurrentIntentSession?: (tag?: IntentSessionTag) => boolean;
}
export interface HostBridgeHandler {
	handle(context: HostBridgeHandleContext): Promise<{ handled: boolean; data?: unknown }>;
}
