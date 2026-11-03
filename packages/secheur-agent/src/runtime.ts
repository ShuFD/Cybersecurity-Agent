import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	createAgentSession,
	DefaultResourceLoader,
	initTheme,
	type LoadExtensionsResult,
	type ModelRuntime,
	type PromptOptions,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@earendil-works/pi-telemetry";
import repoAuditExtension from "@repoaudit/typescript-adapter";
import type { CompetitionCoordinatorBinding, CompetitionSolverBinding } from "./competition-solver.ts";
import {
	disabledRegistryNames,
	isRegistryResourceEnabled,
	type LoadSecHeurConfigOptions,
	loadSecHeurConfig,
	type SecHeurConfig,
} from "./config.ts";
import type { ExecutionMode, ExecutionModeSpec } from "./execution-mode.ts";
import {
	CTF_LENGTH_NO_TOOL_RECOVERY_PROMPT,
	type CtfContinuationState,
	createSecHeurExtension,
	createSecHeurState,
	type SecHeurExtensionState,
	seedRejectedPlanningVerifierEvidence,
	sharePlanningVerifierState,
	type TrustedTaskIdentity,
} from "./extension.ts";
import { ensureDefaultModelCatalog, ensureEnvironmentAuth } from "./model-defaults.ts";
import { boundedAbort } from "./operational-guard.ts";
import type { TrustedPlanningVerification, TrustedPlanningVerificationContext } from "./planning/contracts.ts";
import { planningFailure } from "./planning/failures.ts";
import { attachProgressivePlanningController, planningExecutorExtensionBundle } from "./planning/session-controller.ts";
import { attachSecHeurSessionPolicy, resolveSecHeurThinkingLevel, type SecHeurBudgetStatus } from "./session-policy.ts";

export type { SecHeurBudgetStatus, SecHeurBudgetStopReason } from "./session-policy.ts";

export interface CreateSecHeurRuntimeOptions extends LoadSecHeurConfigOptions {
	cwd?: string;
	persist?: boolean;
	sessionFile?: string;
	sessionManager?: SessionManager;
	sessionId?: string;
	model?: Model<Api>;
	modelRuntime?: ModelRuntime;
	thinkingLevel?: ThinkingLevel;
	telemetryContext?: TelemetryContext;
	permissionMode?: SecHeurConfig["permissionMode"];
	knowledgeBaseEnabled?: boolean;
	mode?: "tui" | "rpc" | "json" | "print";
	competition?: CompetitionSolverBinding;
	competitionCoordinator?: CompetitionCoordinatorBinding;
	ctfContinuation?: CtfContinuationState;
	/** Trusted identity supplied by the Controller/Field for a managed CTF run. */
	trustedTaskIdentity?: TrustedTaskIdentity;
	/** Require a trusted Field target before a managed CTF may call the Flag Oracle. */
	requireTrustedChallengeId?: boolean;
	executionMode?: ExecutionMode | string;
	executionCapacity?: number;
	/** Receives the resolved mode once each routed prompt crosses the mode boundary. */
	onExecutionModeSelected?: (mode: ExecutionModeSpec) => void;
	/** Receives only a persisted Planning verifier result accepted by the canonical gate. */
	onTrustedPlanningVerification?: (
		verification: TrustedPlanningVerification,
		context: TrustedPlanningVerificationContext,
	) => boolean | undefined;
	/** Reads the Bridge prompt generation when a routed Planning prompt begins. */
	getBridgeRunGeneration?: () => number | undefined;
}

export interface SecHeurRuntime {
	readonly config: SecHeurConfig;
	readonly state: SecHeurExtensionState;
	readonly session: AgentSession;
	readonly extensionsResult: LoadExtensionsResult;
	subscribe(listener: AgentSessionEventListener): () => void;
	prompt(message: string, options?: PromptOptions): Promise<void>;
	getCommands(): SecHeurSlashCommand[];
	getBudgetStatus(): SecHeurBudgetStatus;
	abort(reason?: unknown): Promise<void>;
	setPermissionMode(mode: SecHeurConfig["permissionMode"]): void;
	setExecutionCapacity?(capacity: number): number;
	setMemoryReferenceEnabled(enabled: boolean): void;
	setKnowledgeBaseEnabled(enabled: boolean): void;
	setWebVerbsEnabled(enabled: boolean): void;
	dispose(): void;
}

export interface SecHeurSlashCommand {
	name: string;
	description?: string;
	argumentHint?: string;
	source: "builtin" | "extension" | "prompt" | "skill";
}

export function assertRepoAuditPluginLoaded(
	toolNames: readonly string[],
	errors: ReadonlyArray<{ path: string; error: string }>,
): void {
	if (toolNames.includes("repoaudit_scan")) return;
	const diagnostics =
		errors.length > 0
			? errors.map((error) => `${error.path}: ${error.error}`).join("; ")
			: "the extension registered no repoaudit_scan tool";
	throw new Error(`PLUGIN_NOT_LOADED: RepoAudit Pi extension failed to load: ${diagnostics}`);
}

const PI_BUILTIN_SLASH_COMMANDS: ReadonlyArray<Omit<SecHeurSlashCommand, "source">> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", description: "Quit Pi" },
];

export function secHeurSessionDirectory(config: SecHeurConfig, cwd: string): string {
	const encoded = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(config.agentDir, "sessions", encoded);
}

export async function createSecHeurRuntime(options: CreateSecHeurRuntimeOptions = {}): Promise<SecHeurRuntime> {
	const telemetryContext = options.telemetryContext ?? NOOP_TELEMETRY_CONTEXT;
	return telemetryContext.startSpan(
		{
			name: "secheur.runtime.create",
			attributes: {
				"secheur.persist": options.persist !== false,
				"secheur.mode": options.mode ?? "print",
			},
		},
		async () => {
			const loadedConfig = loadSecHeurConfig({ ...options, projectRoot: options.projectRoot ?? options.cwd });
			const cwd = resolve(options.cwd ?? loadedConfig.projectRoot);
			const cwdConfig = cwd === loadedConfig.projectRoot ? loadedConfig : { ...loadedConfig, projectRoot: cwd };
			const config =
				options.knowledgeBaseEnabled === undefined
					? cwdConfig
					: { ...cwdConfig, knowledgeBaseEnabled: options.knowledgeBaseEnabled };
			const thinkingLevel = resolveSecHeurThinkingLevel(config, options.thinkingLevel);
			mkdirSync(config.stateDir, { recursive: true });
			mkdirSync(config.agentDir, { recursive: true });

			const state = createSecHeurState(config, options.permissionMode, options.env);
			let session: AgentSession | undefined;
			try {
				ensureDefaultModelCatalog(config.agentDir, options.env ?? process.env);
				ensureEnvironmentAuth(config.agentDir, options.env ?? process.env);
				const { extension } = createSecHeurExtension({
					config,
					state,
					registerInactiveKnowledgeBaseTool: true,
					competition: options.competition,
					competitionCoordinator: options.competitionCoordinator,
					ctfContinuation: options.ctfContinuation,
					trustedTaskIdentity: options.trustedTaskIdentity,
					requireTrustedChallengeId: options.requireTrustedChallengeId,
				});
				const settingsManager = SettingsManager.create(cwd, config.agentDir);
				initTheme(settingsManager.getTheme(), false);
				const resourceLoader = new DefaultResourceLoader({
					cwd,
					agentDir: config.agentDir,
					settingsManager,
					extensionFactories: [extension, repoAuditExtension],
					additionalSkillPaths: config.skillPaths,
					systemPrompt: config.systemPromptPath,
					appendSystemPrompt: [
						"SecHeur compatibility tools are available through Pi extensions. Keep Pi as the only conversation loop.",
					],
					skillsOverride: ({ skills, diagnostics }) => ({
						skills: skills.filter((skill) => isRegistryResourceEnabled(config, "skills", skill.name)),
						diagnostics,
					}),
				});
				await resourceLoader.reload();
				if (
					!options.model &&
					!settingsManager.getDefaultProvider() &&
					!settingsManager.getDefaultModel() &&
					(options.env ?? process.env).SECHEUR_ROUTER_DEFAULT !== "0"
				) {
					settingsManager.setDefaultModelAndProvider("router", "auto");
					settingsManager.setDefaultThinkingLevel("max");
				}

				const sessionManager =
					options.sessionManager ??
					(options.sessionFile
						? SessionManager.open(options.sessionFile, secHeurSessionDirectory(config, cwd), cwd)
						: options.persist === false
							? SessionManager.inMemory(cwd, { id: options.sessionId })
							: SessionManager.create(cwd, secHeurSessionDirectory(config, cwd), { id: options.sessionId }));
				if (options.sessionId !== undefined && sessionManager.getSessionId() !== options.sessionId) {
					throw new Error(
						`SecHeur session ID mismatch: expected ${options.sessionId}, received ${sessionManager.getSessionId()}`,
					);
				}
				const created = await createAgentSession({
					cwd,
					agentDir: config.agentDir,
					settingsManager,
					resourceLoader,
					sessionManager,
					model: options.model,
					modelRuntime: options.modelRuntime,
					thinkingLevel,
					excludeTools: disabledRegistryNames(config, "tools").filter(
						(name) => name !== "attack_memory_search" || config.registry.tools.attack_memory_search === false,
					),
				});
				session = created.session;
				await session.bindExtensions({
					mode: options.mode ?? "print",
					onError: (error) => {
						if (process.env.SECHEUR_DEBUG === "1") {
							console.error(`SecHeur extension error (${error.extensionPath}): ${error.error}`);
						}
					},
				});
				assertRepoAuditPluginLoaded(
					session.getAllTools().map((tool) => tool.name),
					created.extensionsResult.errors,
				);
				session.setActiveToolsByName(
					session
						.getAllTools()
						.map((tool) => tool.name)
						.filter((name) => name !== "attack_memory_search" || state.isKnowledgeBaseEnabled()),
				);

				const activeSession = session;
				const promptTelemetry = new AsyncLocalStorage<TelemetryContext>();
				const streamFunction = activeSession.agent.streamFunction;
				activeSession.agent.streamFunction = async (model, context, streamOptions) => {
					await state.operationalGuard?.waitForVerificationSettlement(streamOptions?.signal);
					if (
						state.operationalGuard?.verificationState === "quota_exhausted" ||
						(!options.competition?.verifiedSubmission && options.competition?.remainingAttempts === 0)
					)
						throw planningFailure("controller", "verifier_quota_exhausted", "Verification quota exhausted");
					if (options.competition?.verifiedSubmission || state.operationalGuard?.verificationState === "accepted")
						throw planningFailure(
							"controller",
							"verified_goal_complete",
							"Trusted verification already completed this run",
						);
					return streamFunction(model, context, {
						...streamOptions,
						telemetryContext: promptTelemetry.getStore() ?? telemetryContext,
					});
				};
				const sessionPolicy = attachSecHeurSessionPolicy(
					activeSession,
					config,
					() => Boolean(state.commandTasks?.pendingCount),
					() => {
						void state.commandTasks?.cancelAll();
					},
					state.operationalGuard,
				);
				const planningBinding = attachProgressivePlanningController(activeSession, {
					beforeDispatch: async (signal) => {
						await state.operationalGuard?.waitForVerificationSettlement(signal);
						if (
							state.operationalGuard?.verificationState === "quota_exhausted" ||
							(!options.competition?.verifiedSubmission && options.competition?.remainingAttempts === 0)
						)
							throw planningFailure("controller", "verifier_quota_exhausted", "Verification quota exhausted");
						if (
							options.competition?.verifiedSubmission ||
							state.operationalGuard?.verificationState === "accepted"
						)
							throw planningFailure(
								"controller",
								"verified_goal_complete",
								"Trusted verification already completed this run",
							);
					},
					config,
					cwd,
					onModelTurn: (cost) => {
						sessionPolicy.recordExternalTurn(cost);
						return sessionPolicy.getBudgetStatus();
					},
					onPresentationEvidence: (snapshot) => seedRejectedPlanningVerifierEvidence(state, snapshot),
					onExecutionModeSelected: options.onExecutionModeSelected,
					onTrustedPlanningVerification: options.onTrustedPlanningVerification,
					getBridgeRunGeneration: options.getBridgeRunGeneration,
					createExtensionBundle(scope) {
						const child = createSecHeurExtension({
							config,
							permissionMode: state.permissions.mode,
							env: options.env,
							subAgentDepth: 1,
							commandTaskScope: scope?.leaseId,
							ctfContinuation: options.ctfContinuation
								? { ...options.ctfContinuation, consecutiveNoToolTurns: 0, pendingLengthRecovery: false }
								: undefined,
							allowKnowledgeBaseRetrieval: activeSession
								.getAllTools()
								.some((tool) => tool.name === "attack_memory_search"),
							competition: options.competition,
							competitionCoordinator: options.competitionCoordinator,
							trustedTaskIdentity: options.trustedTaskIdentity,
							requireTrustedChallengeId: options.requireTrustedChallengeId,
							// Planning children share the parent's task context and
							// retrieval ledger; the parent's bootstrap is never repeated.
							knowledgeCoordinator: state.knowledgeCoordinator,
						});
						if (config.executionMode.mode === "plan_multi") sharePlanningVerifierState(state, child.state);
						const bundle = planningExecutorExtensionBundle(child.extension, () => child.state.close(), [
							repoAuditExtension,
						]);
						bundle.backgroundTasks = {
							hasPending: () => Boolean(child.state.commandTasks?.pendingCount),
							waitForSettlement: async (signal) => {
								await child.state.commandTasks?.waitForSettlement(signal);
							},
							settledExecutions: () => child.state.commandTasks?.settledExecutions() ?? [],
						};
						return bundle;
					},
				});
				let disposed = false;
				let promptCancelled = false;
				return {
					config,
					state,
					session: activeSession,
					extensionsResult: created.extensionsResult,
					subscribe(listener) {
						return activeSession.subscribe(listener);
					},
					async prompt(message, promptOptions) {
						if (disposed) throw new Error("SecHeur runtime has been disposed");
						if (config.maxTurns !== undefined && (state.operationalGuard?.turnsUsed ?? 0) >= config.maxTurns)
							throw new Error("Parent turn budget already exhausted; recovery cannot reset it");
						if (config.maxCost !== undefined && (state.operationalGuard?.costUsed ?? 0) >= config.maxCost)
							throw new Error("Parent cost budget already exhausted; recovery cannot reset it");
						promptCancelled = false;
						sessionPolicy.beginPrompt();
						state.commandTasks?.beginRun();
						await telemetryContext.startSpan(
							{
								name: "secheur.runtime.prompt",
								attributes: {
									"secheur.session.id": activeSession.sessionId,
									"secheur.prompt.length": message.length,
									"secheur.prompt.source": promptOptions?.source ?? "interactive",
								},
							},
							async (span) =>
								promptTelemetry.run(span, async () => {
									await activeSession.prompt(message, promptOptions);
									await activeSession.waitForIdle();
									while (options.ctfContinuation?.pendingLengthRecovery) {
										options.ctfContinuation.pendingLengthRecovery = false;
										if (
											disposed ||
											promptCancelled ||
											sessionPolicy.getBudgetStatus().stopped ||
											options.ctfContinuation.verificationState === "accepted" ||
											options.ctfContinuation.verificationAttemptsRemaining === 0 ||
											state.operationalGuard?.remainingAttempts === 0
										)
											break;
										state.operationalGuard?.takeRecovery();
										await activeSession.prompt(
											CTF_LENGTH_NO_TOOL_RECOVERY_PROMPT +
												"\n" +
												(state.operationalGuard?.context(state.commandTasks?.pendingContext()) ?? ""),
											{ source: "extension", expandPromptTemplates: false },
										);
										await activeSession.waitForIdle();
									}
								}),
						);
						while (state.commandTasks?.pendingCount) {
							if (
								options.ctfContinuation?.verificationState === "accepted" ||
								options.ctfContinuation?.verificationAttemptsRemaining === 0 ||
								state.operationalGuard?.remainingAttempts === 0 ||
								sessionPolicy.getBudgetStatus().stopped
							) {
								await state.commandTasks.cancelAll();
								break;
							}
							await state.commandTasks.waitForChange();
							await activeSession.waitForIdle();
						}
					},
					getCommands() {
						const commands: SecHeurSlashCommand[] = PI_BUILTIN_SLASH_COMMANDS.map((command) => ({
							...command,
							source: "builtin",
						}));
						commands.push(
							...activeSession.extensionRunner.getRegisteredCommands().map((command) => ({
								name: command.invocationName,
								description: command.description,
								source: "extension" as const,
							})),
							...activeSession.promptTemplates.map((template) => ({
								name: template.name,
								description: template.description,
								argumentHint: template.argumentHint,
								source: "prompt" as const,
							})),
							...activeSession.resourceLoader.getSkills().skills.map((skill) => ({
								name: `skill:${skill.name}`,
								description: skill.description,
								source: "skill" as const,
							})),
						);
						const seen = new Set<string>();
						return commands.filter((command) => {
							const key = command.name.toLowerCase();
							if (!key || seen.has(key)) return false;
							seen.add(key);
							return true;
						});
					},
					getBudgetStatus() {
						return sessionPolicy.getBudgetStatus();
					},
					async abort(reason?: unknown) {
						if (disposed) return;
						promptCancelled = true;
						planningBinding.abort(reason);
						// Abort the Pi loop immediately, rather than waiting behind a
						// non-cooperative tool before it receives the cancellation.
						const stopped = await boundedAbort(
							Promise.all([state.commandTasks?.cancelAll(), activeSession.abort(reason)]),
						);
						if (!stopped) {
							state.legacyHost.close();
							activeSession.dispose();
						}
					},
					setPermissionMode(mode) {
						state.permissions.setMode(mode);
					},
					setExecutionCapacity(capacity) {
						return planningBinding.setExecutionCapacity(capacity);
					},
					setMemoryReferenceEnabled(enabled) {
						state.setMemoryReferenceEnabled(enabled);
					},
					setKnowledgeBaseEnabled(enabled) {
						config.knowledgeBaseEnabled = enabled;
						state.setKnowledgeBaseEnabled(enabled);
						const activeToolNames = new Set(activeSession.getActiveToolNames());
						if (enabled && activeSession.getAllTools().some((tool) => tool.name === "attack_memory_search")) {
							activeToolNames.add("attack_memory_search");
						} else {
							activeToolNames.delete("attack_memory_search");
						}
						activeSession.setActiveToolsByName([...activeToolNames]);
					},
					setWebVerbsEnabled(enabled) {
						state.setWebVerbsEnabled(enabled);
					},
					dispose() {
						if (disposed) return;
						disposed = true;
						planningBinding.close();
						sessionPolicy.dispose();
						activeSession.dispose();
						state.close();
					},
				};
			} catch (error) {
				session?.dispose();
				state.close();
				throw error;
			}
		},
	);
}

export function formatAssistantText(event: AgentSessionEvent): string | undefined {
	if (event.type !== "message_end" || event.message.role !== "assistant") return undefined;
	return event.message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
