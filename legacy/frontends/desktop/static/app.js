window.process = window.process || { platform: navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'win32' };
// SecHeur Agent Desktop — Renderer Logic
// Handles UI state, sessions, streaming, slash commands.

'use strict';

const bridgeApi = window.secheurAgent;
const MODEL_FIRST_OUTPUT_WARNING_MS = 30000;
const MODEL_IDLE_WARNING_MS = 5 * 60 * 1000;
const SESSION_LIST_REFRESH_MS = 3000;
// 会话列表只展示摘要；完整历史在选中会话后按需读取，避免启动时一次性展开所有记录。
const SESSION_HISTORY_BOOTSTRAP_LIMIT = 200;
// 显式导入、分支和树切换需要完整上下文。Bridge 约定 limit=0 表示不截断。
const SESSION_HISTORY_FULL_LIMIT = 0;
const HEURISTIC_LEARNING_SKILL_NAME = 'heuristic-learning';
const HEURISTIC_LEARNING_STORAGE_KEY = 'secheur:heuristic-learning-enabled';
const WEB_VERBS_STORAGE_KEY = 'secheur:web-verbs-enabled';
const HEURISTIC_LEARNING_PROMPT_PREFIX = `请先调用 skill 工具执行 ${HEURISTIC_LEARNING_SKILL_NAME}，然后严格使用该 skill 的方法完成下面任务。`;

// ─── State ────────────────────────────────────────────────────────────────
const state = {
  sessions: new Map(),      // localSessionId -> { id, bridgeSessionId, title, messages: [], cwd, config, diagnostics }
  solverSessions: new Map(), // bridgeSessionId -> lightweight solver snapshot; full sessions load on demand
  activeId: null,
  sessionSelectionVersion: 0,
  newSessionPlanningEngine: null,
  planningSelectionSaving: false,
  bridgeReady: false,
  managedBridge: false,
  defaultConfig: {
    theme: 'white',
    llmNo: 0,
    projectRoot: '',
    composerSendShortcut: 'enter',
    maxTurns: 80,
    maxCost: '',
    thinkingMode: 'adaptive',
    thinkingBudget: '',
    permissionMode: 'default',
    memoryReferenceEnabled: true,
    knowledgeBaseEnabled: false,
    mcpAutoRefresh: false,
    uiScale: 100,
    canvasWidthMode: 'narrow',
    userMsgColor: '',
    uiFontFamily: '',
    codeFontFamily: '',
    codeFontSize: 13,
    streamingEnabled: true,
    browserAgentEnabled: true,
    browserAgentPreferBuiltIn: true,
    browserAgentAllowExternalProviderFallback: true,
    systemProxyEnabled: false,
    systemProxyUrl: '',
    terminalShellPath: '',
    notificationSoundsEnabled: true,
    systemNotificationEnabled: true,
    backendMode: 'local',
    autoCompactionEnabled: true,
    attemptDedupEnabled: false,
    autoCompactionThresholdPercent: 85,
    maxHotRuntimes: 1,
    maxWarmRuntimes: 1,
    warmTtlSeconds: 7200,
    agentFirstOutputTimeoutSeconds: 120,
    agentOutputIdleTimeoutSeconds: 600,
    customSkillDirectories: '',
    preloadGitDiffs: true,
    autoOpenFileEnabled: false,
    diffExpandedByDefault: false,
    openAppTargets: ''
  },
  apiConfig: null,
  registry: { mcpServers: [], skills: [], agents: [], tools: [], sources: {} },
  registryFilters: { mcpServers: '', skills: '', agents: '', tools: '' },
  plugins: { plugins: [], diagnostics: [], settingsPaths: {} },
  pluginFilter: '',
  pluginBusy: false,
  modelProfiles: [],
  apiModels: [],
  apiModelsContextKey: '',
  restartingBridge: false,
  bridgeNoticeMessage: null,
  mykeyReady: true,
  runtimeBySessionId: new Map(),
  sessionPositions: new Map(), // bridgeSessionId -> 固定排序序号，只在新建或拖动时改变。
  nextSessionPosition: 0,
  closedSessionIds: new Set(),
  closedBridgeSessionIds: new Set(),
  activeSettingsSection: 'general',
  configLoaded: false,
  pendingBridgeReadyNotice: null,
  pendingAttachmentCount: 0,
  attachmentSelectionBusy: false,
  composerNoticeText: '',
  composerNoticeTimer: null,
  worklist: {
    running: false,
    configured: false,
    items: [],
    activeEnvironmentCount: 0,
    activeAttachmentCount: 0,
    maxEnvironmentCount: 3,
    maxFlagAttempts: 3,
    maxFailures: 2,
  },
};

// Helper: get config/diagnostics for the active session (or defaults)
function getActiveConfig() {
  const sess = state.sessions.get(state.activeId);
  return sess ? sess.config : state.defaultConfig;
}
function getActiveDiagnostics() {
  const sess = state.sessions.get(state.activeId);
  return sess ? sess.diagnostics : [];
}

function modelProfileId(profile) {
  return Number(profile?.llmNo ?? profile?.id ?? profile?.index ?? 0) || 0;
}

function modelProfileLabel(profile) {
  if (!profile) return '默认 / 自动';
  return profile.name && profile.model
    ? `${profile.name}/${profile.model}`
    : profile.name || profile.model || `模型 ${modelProfileId(profile)}`;
}

function modelProfileById(llmNoValue) {
  const llmNo = Math.max(0, parseInt(llmNoValue || '0', 10) || 0);
  const profiles = Array.isArray(state.modelProfiles) ? state.modelProfiles : [];
  return profiles.find((profile) => modelProfileId(profile) === llmNo) || null;
}

function apiProfileNameFromModelProfile(profile) {
  const raw = String(profile?.name || profile?.model || '').trim();
  if (!raw) return '';
  const parts = raw.split('/').map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : raw;
}

function findSavedApiProfile(name) {
  const query = String(name || '').trim();
  if (!query) return null;
  const profiles = Array.isArray(state.apiConfig?.profiles) ? state.apiConfig.profiles : [];
  return profiles.find((profile) => {
    const cfg = profile?.config || {};
    return [
      profile?.name,
      profile?.id,
      cfg.name,
      cfg.model,
      profile?.model,
    ].some((candidate) => String(candidate || '').trim() === query);
  }) || null;
}

function composerApiContext(sess = state.sessions.get(state.activeId)) {
  const cfg = sess?.config || getActiveConfig();
  const modelProfile = modelProfileById(cfg?.llmNo);
  const apiProfileName = apiProfileNameFromModelProfile(modelProfile);
  const savedProfile = findSavedApiProfile(apiProfileName);
  if (savedProfile) {
    const savedConfig = savedProfile.config || {};
    return {
      config: {
        ...savedConfig,
        name: savedProfile.name || savedConfig.name || apiProfileName,
        type: savedProfile.type || savedConfig.type || 'native_oai',
        model: savedProfile.model || savedConfig.model || '',
        apibase: savedProfile.apibase || savedConfig.apibase || '',
      },
      hasApiKey: !!savedProfile.hasApiKey,
      profile: savedProfile,
      modelProfile,
    };
  }
  return {
    config: state.apiConfig?.config || {},
    hasApiKey: !!state.apiConfig?.hasApiKey,
    profile: null,
    modelProfile,
  };
}

function syncComposerApiModelFromSelectedProfile(sess = state.sessions.get(state.activeId)) {
  if (!sess) return '';
  const context = composerApiContext(sess);
  const model = String(context.config?.model || '').trim();
  sess.composerApiModelValue = model;
  return model;
}

function apiModelsContextKey(cfg) {
  return [
    cfg?.type || '',
    cfg?.name || '',
    cfg?.apibase || '',
    cfg?.api_mode || '',
  ].map((part) => String(part || '').trim()).join('\n');
}

function projectRootFromPayload(payload) {
  return payload?.projectRoot || '';
}

const NON_PERSISTENT_CONFIG_KEYS = new Set(['projectRoot']);

function persistentDesktopConfig(config) {
  const out = {};
  for (const [key, value] of Object.entries(config || {})) {
    if (!NON_PERSISTENT_CONFIG_KEYS.has(key)) out[key] = value;
  }
  if (state.newSessionPlanningEngine) out.newSessionPlanningEngine = state.newSessionPlanningEngine;
  return out;
}

async function persistDesktopConfig(config) {
  return bridgeApi.saveConfig(persistentDesktopConfig(config));
}

function ensureChatView() {
  messagesEl?.classList.remove('hidden');
  composerWrapEl?.classList.remove('hidden');
  renderGoalPlan();
  renderBlackboardGraph();
}

// ─── DOM refs ─────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('input');
const slashHighlightEl = $('slash-highlight');
const slashAutocompleteEl = $('slash-autocomplete');
const newContentBtn = $('new-content-btn');
const sendBtn = $('send-btn');
const composerEl = $('composer');
const composerModelSelect = $('composer-llm');
const composerApiModelSelect = $('composer-api-model');
const composerPermissionSelect = $('composer-permission-mode');
const composerHeuristicLearningToggle = $('composer-heuristic-learning');
const composerWebVerbsToggle = $('composer-web-verbs');
const composerAddBtn = $('composer-add-btn');
const composerFileInput = $('composer-file-input');
const composerActivityEl = $('composer-activity');
const composerActivityTextEl = $('composer-activity-text');
const sessionListEl = $('session-list');
const solverSectionEl = $('solver-section');
const solverListEl = $('solver-list');
const solverSummaryCountEl = $('solver-summary-count');
const sessionTitleEl = $('session-title');
const worklistSummaryEl = $('worklist-summary');
const worklistListEl = $('worklist-list');
const worklistSyncBtn = $('worklist-sync-btn');
const worklistToggleBtn = $('worklist-toggle-btn');
const benchmarkEntryPanelTemplate = document.querySelector('.benchmark-entry-panel')?.cloneNode(true);
const sidebarBrandEl = $('sidebar-brand');
const statusBadge = $('status-badge');
const statusText = $('status-text');
const settingsModal = $('settings-modal');
const errorBanner = $('error-banner');
const diagnosticsPanel = $('diagnostics-panel');
const diagnosticsLogEl = $('diagnostics-log');
const settingsDiagnosticsLogEl = $('settings-diagnostics-log');
const sessionLogPanel = $('session-log-panel');
const sessionLogContentEl = $('session-log-content');
const sessionLogSubtitleEl = $('session-log-subtitle');
const composerWrapEl = $('composer-wrap');
const goalPlanPanelEl = $('goal-plan-panel');
const goalPlanSummaryEl = $('goal-plan-summary');
const goalPlanListEl = $('goal-plan-list');
const goalPlanToggleEl = $('goal-plan-toggle');
const blackboardGraphFloatEl = $('blackboard-graph-float');
const blackboardGraphToggleBtn = $('blackboard-graph-toggle');
const blackboardGraphCollapseBtn = $('blackboard-graph-collapse');
const blackboardGraphBodyEl = $('blackboard-graph-body');
const blackboardGraphCanvasEl = $('blackboard-graph-canvas');
const blackboardGraphAnimationCanvasEl = $('blackboard-graph-animation');
const blackboardGraphSvgEl = $('blackboard-graph-svg');
const blackboardGraphNodesEl = $('blackboard-graph-nodes');
const blackboardGraphSummaryEl = $('blackboard-graph-summary');
const blackboardGraphEmptyEl = $('blackboard-graph-empty');
const blackboardGraphDetailEl = $('blackboard-graph-detail');
const blackboardGraphDetailTitleEl = $('blackboard-graph-detail-title');
const blackboardGraphDetailBodyEl = $('blackboard-graph-detail-body');
const blackboardGraphTimelineEl = $('blackboard-graph-timeline');
const trajectoryViewerTriggerBtn = $('trajectory-viewer-trigger');
const tempAgentFloatEl = $('temp-agent-float');
const tempAgentFloatTitleEl = $('temp-agent-float-title');
const tempAgentFloatStatusEl = $('temp-agent-float-status');
const tempAgentFloatDialogEl = $('temp-agent-float-dialog');
const tempAgentFloatToggleBtn = $('temp-agent-float-toggle');
const tempAgentFloatCloseBtn = $('temp-agent-float-close');
let tempAgentFloatUserCollapsed = null;
let tempAgentFloatDialogId = null;
let tempAgentFloatHiddenDialogId = null;
const THEME_OPTIONS = [
  { id: 'auto', label: '跟随系统', colors: ['#0d0f14', '#ffffff', '#7a9dcc'] },
  { id: 'dark', label: '深色经典', colors: ['#0d0f14', '#1f1f25', '#7a9dcc'] },
  { id: 'light', label: '浅色现代', colors: ['#f6f7f9', '#ffffff', '#356fa8'] },
  { id: 'white', label: '纯白', colors: ['#ffffff', '#f5f7fb', '#2563eb'] },
  { id: 'graphite', label: '石墨灰', colors: ['#171717', '#2e2e2e', '#d6a85c'] },
  { id: 'carbon', label: '碳黑高对比', colors: ['#050607', '#11161a', '#00b8a9'] },
  { id: 'aurora', label: '极光绿', colors: ['#0b1411', '#13221d', '#77d69f'] },
  { id: 'ruby', label: '胭脂红', colors: ['#170b10', '#25141c', '#ff8aa8'] },
  { id: 'cobalt', label: '钴蓝', colors: ['#09111c', '#101d2d', '#7db7ff'] },
  { id: 'daylight', label: '日间蓝白', colors: ['#f4f8fb', '#ffffff', '#217f9b'] }
];
const VALID_THEMES = new Set(THEME_OPTIONS.map((theme) => theme.id));
const THEME_LABELS = {
  auto: '跟随系统',
  dark: '深色经典',
  light: '浅色现代',
  white: '纯白',
  graphite: '石墨灰',
  carbon: '碳黑高对比',
  aurora: '极光绿',
  ruby: '胭脂红',
  cobalt: '钴蓝',
  daylight: '日间蓝白'
};

function openBenchmarkScenario(target) {
  const dialog = $('benchmark-scenario-dialog');
  if (!dialog || dialog.open) return;
  $('benchmark-scenario-code').textContent = target.dataset.benchmarkScenario;
  $('benchmark-scenario-title').textContent = target.dataset.scenarioTitle;
  $('benchmark-scenario-description').textContent = target.dataset.scenarioDescription;
  dialog.showModal();
}

function setupBenchmarkDashboardShortcut() {
  if (!sidebarBrandEl && !messagesEl) return;
  let clickCount = 0;
  let resetTimer = null;

  function resetClicks() {
    clickCount = 0;
    resetTimer = null;
  }

  function openBenchmarkDashboard() {
    window.location.href = '/benchmark-dashboard/';
  }

  function registerClick() {
    clickCount += 1;
    if (resetTimer) clearTimeout(resetTimer);
    if (clickCount >= 3) {
      openBenchmarkDashboard();
      return;
    }
    resetTimer = setTimeout(resetClicks, 900);
  }

  messagesEl?.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const target = event.target.closest('[data-benchmark-scenario]');
    if (target) openBenchmarkScenario(target);
  });
  $('benchmark-scenario-close')?.addEventListener('click', () => $('benchmark-scenario-dialog').close());
  sidebarBrandEl?.addEventListener('click', registerClick);
  sidebarBrandEl?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    registerClick();
  });
}

const WEB_SLASH_COMMANDS = [
  { name: 'help', usage: '/help', desc: '查看可用指令' },
  { name: 'new', usage: '/new', desc: '新建会话' },
  { name: 'clear', usage: '/clear', desc: '清空当前会话显示' },
  { name: 'stop', usage: '/stop', desc: '取消当前任务' },
  { name: 'agent', usage: '/agent 1', argumentHint: '<number>', desc: '查看或切换 Agent' },
  { name: 'theme', usage: '/theme white', argumentHint: '<theme>', desc: '切换主题' },
  { name: 'settings', usage: '/settings api', argumentHint: '<section>', desc: '打开设置页' },
  { name: 'mcp', usage: '/mcp', desc: '刷新 MCP 工具' },
  { name: 'skills', usage: '/skills', desc: '打开技能管理' },
  { name: 'skill', usage: '/skill', desc: '打开技能管理' },
  { name: 'plugins', usage: '/plugins', desc: '打开 Pi 插件管理' },
  { name: 'memory', usage: '/memory', desc: '打开记忆搜索' },
  { name: 'permissions', usage: '/permissions', desc: '查看权限切换位置' },
  { name: 'cwd', usage: '/cwd /path/to/project', argumentHint: '<path>', desc: '切换工作目录' },
  { name: 'restart', usage: '/restart', desc: '重启 Bridge' },
];
const WEB_SLASH_COMMAND_NAMES = new Set(WEB_SLASH_COMMANDS.map((command) => command.name));
const WEB_PI_BUILTIN_NAMES = new Set([
  'settings', 'model', 'scoped-models', 'export', 'import', 'share', 'copy', 'name', 'session',
  'changelog', 'hotkeys', 'fork', 'clone', 'tree', 'trust', 'login', 'logout', 'new', 'compact',
  'resume', 'reload', 'quit',
]);
let slashSuggestionIndex = 0;

function normalizeSlashCommand(command) {
  const name = String(command?.name || '').trim().replace(/^\/+/, '');
  if (!name || /\s/.test(name)) return null;
  const source = ['builtin', 'extension', 'prompt', 'skill', 'web'].includes(command?.source)
    ? command.source
    : 'web';
  const argumentHint = String(command?.argumentHint || '').trim();
  const tuiOnly = source === 'builtin' && !WEB_PI_BUILTIN_NAMES.has(name) && !WEB_SLASH_COMMAND_NAMES.has(name);
  const description = String(command?.desc || command?.description || '').trim() || 'Pi 命令';
  return {
    name,
    source,
    argumentHint,
    tuiOnly,
    usage: String(command?.usage || `/${name}${argumentHint ? ` ${argumentHint}` : ''}`),
    desc: tuiOnly ? `${description}（仅 Pi TUI 可用）` : description,
  };
}

function getSlashCommands(sess = state.sessions.get(state.activeId)) {
  const commands = [
    ...WEB_SLASH_COMMANDS.map((command) => ({ ...command, source: 'web' })),
    ...(Array.isArray(sess?.piSlashCommands) ? sess.piSlashCommands : []),
  ];
  const seen = new Set();
  return commands.flatMap((command) => {
    const normalized = normalizeSlashCommand(command);
    const key = normalized?.name.toLowerCase();
    if (!normalized || seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
}

function findSlashCommand(name, sess = state.sessions.get(state.activeId)) {
  const key = String(name || '').toLowerCase();
  return getSlashCommands(sess).find((command) => command.name.toLowerCase() === key) || null;
}

async function loadSessionSlashCommands(sess, options = {}) {
  if (!sess?.bridgeSessionId) return getSlashCommands(sess);
  if (!options.force && Array.isArray(sess.piSlashCommands)) return getSlashCommands(sess);
  if (sess.slashCommandsPromise) return sess.slashCommandsPromise;
  if (options.force) sess.piSlashCommands = null;
  const sessionId = sess.bridgeSessionId;
  sess.slashCommandsPromise = bridgeApi.rpc('session/commands', { sessionId })
    .then((result) => {
      if (sess.bridgeSessionId !== sessionId) return getSlashCommands(sess);
      sess.piSlashCommands = Array.isArray(result?.commands) ? result.commands : [];
      if (isActiveSession(sess) && inputEl?.value.startsWith('/')) updateSlashAssist(true);
      return getSlashCommands(sess);
    })
    .catch((error) => {
      addDiagnostic('warn', '加载 Pi 命令失败', error);
      return getSlashCommands(sess);
    })
    .finally(() => {
      sess.slashCommandsPromise = null;
    });
  return sess.slashCommandsPromise;
}

function invalidateSlashCommandCaches() {
  for (const sess of state.sessions.values()) sess.piSlashCommands = null;
  const active = state.sessions.get(state.activeId);
  if (active) void loadSessionSlashCommands(active, { force: true });
}

const COMPOSER_PERMISSION_LABELS = {
  default: '默认权限',
  acceptEdits: '自动接受编辑',
  dontAsk: '自动审查',
  bypassPermissions: '完全访问权限',
  plan: '计划模式',
};


// ─── Diagnostics ─────────────────────────────────────────────────────────
const MAX_DIAGNOSTICS = 200;

function diagnosticText(payload) {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (payload instanceof Error) return payload.stack || payload.message;
  try {
    return JSON.stringify(payload);
  } catch (_) {
    return String(payload);
  }
}

function addDiagnostic(level, message, payload) {
  const ts = new Date().toISOString();
  const detail = diagnosticText(payload);
  const diags = getActiveDiagnostics();
  diags.push({ ts, level, message, detail });
  if (diags.length > MAX_DIAGNOSTICS) diags.shift();
  renderDiagnostics();
}

function formatDiagnostics() {
  const diags = getActiveDiagnostics();
  if (diags.length === 0) return '暂无诊断日志。';
  return diags.map((entry) => {
    const suffix = entry.detail ? `\n  ${entry.detail}` : '';
    return `[${entry.ts}] ${entry.level.toUpperCase()} ${entry.message}${suffix}`;
  }).join('\n');
}

function renderDiagnostics() {
  if (diagnosticsLogEl) diagnosticsLogEl.textContent = formatDiagnostics();
  if (settingsDiagnosticsLogEl) settingsDiagnosticsLogEl.textContent = formatDiagnostics();
}

function openDiagnostics() {
  renderDiagnostics();
  if (!diagnosticsPanel) return;
  diagnosticsPanel.classList.remove('hidden');
  diagnosticsPanel.setAttribute('aria-hidden', 'false');
}

function closeDiagnostics() {
  if (!diagnosticsPanel) return;
  diagnosticsPanel.classList.add('hidden');
  diagnosticsPanel.setAttribute('aria-hidden', 'true');
}

async function copyDiagnostics() {
  const text = formatDiagnostics();
  try {
    await copyText(text);
    addDiagnostic('info', '诊断日志已复制到剪贴板');
  } catch (err) {
    addDiagnostic('error', '复制诊断日志失败', err);
    showError('复制诊断日志失败：' + (err.message || err), null, null, { skipDiagnostic: true });
  }
}

async function copyText(text) {
  if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持剪贴板写入');
  await navigator.clipboard.writeText(String(text || ''));
}

function createEl(tag, className = '', text = null) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== null && text !== undefined) el.textContent = text;
  return el;
}

function closeIconSvg(size = 14) {
  const px = Number(size) || 14;
  return `<svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M18 6 6 18"/>
    <path d="m6 6 12 12"/>
  </svg>`;
}

function downloadIconSvg(size = 14) {
  const px = Number(size) || 14;
  return `<svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M12 3v12"/>
    <path d="m7 10 5 5 5-5"/>
    <path d="M5 21h14"/>
  </svg>`;
}

function saveToFieldIconSvg(size = 14) {
  const px = Number(size) || 14;
  return `<svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M12 21V9"/>
    <path d="m7 14 5-5 5 5"/>
    <path d="M5 3h14"/>
  </svg>`;
}

function listLogIconSvg(size = 14) {
  const px = Number(size) || 14;
  return `<svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M8 6h13"/>
    <path d="M8 12h13"/>
    <path d="M8 18h13"/>
    <path d="M3 6h.01"/>
    <path d="M3 12h.01"/>
    <path d="M3 18h.01"/>
  </svg>`;
}

function projectShieldIconSvg(size = 16) {
  const px = Number(size) || 16;
  return `<svg t="1781333257273" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="2076" width="${px}" height="${px}" aria-hidden="true" focusable="false">
    <path d="M786.29 745.36c-94.78 142.39-268.28 206.38-274.69 213.1a641.454 641.454 0 0 1-271.51-212.52c-94.91-142.55-112.04-363.65-112.04-363.65V206.23a796.362 796.362 0 0 0 202.92-42.8A934.006 934.006 0 0 0 518.84 62.18a831.345 831.345 0 0 0 175.23 99.04 799.157 799.157 0 0 0 201.22 45.01v176.06a779.629 779.629 0 0 1-109 363.07z m44.43-344.24V250.18a650.654 650.654 0 0 1-167.61-38.41 689.44 689.44 0 0 1-145.91-84.93 770.893 770.893 0 0 1-156.44 86.78 645.668 645.668 0 0 1-169.02 36.68v150.93s14.34 189.54 93.38 311.72a535.424 535.424 0 0 0 226.09 182.21c5.35-5.76 149.84-60.63 228.78-182.69 54.78-95 85.89-201.79 90.73-311.35zM580.08 567.99l98.85 37.48-24.74 46.1-117.1-51.22a526.087 526.087 0 0 1-164.89 49.87c-9.41-19.06-17.55-34.42-24.42-46.1 44.6-4.49 88.55-14.01 131.02-28.36-30.24-12.38-57.41-23.05-81.5-32.01 11.59-17.07 22.48-34.85 32.68-53.33h-81.85v-43.31h104.2a884.25 884.25 0 0 0 22.41-51.57l55.38 14.44-20.3 37.13h178.46v43.31H625.7a204.12 204.12 0 0 1-45.62 77.57z m-95.11-77.72c-7.34 12.53-14.33 24-20.97 34.41l65.69 24.39a131.282 131.282 0 0 0 40.75-58.8h-85.47z m140.85-101.09H411.35v30.95h-49.87V346.5h132.05c-3.2-8.93-6.4-17.41-9.6-25.45l56.76-11.33 13.06 36.78h122.06v74.97h-49.84v-32.33l-0.15 0.04z" p-id="2077" fill="#d87945"></path>
  </svg>`;
}

function appendChildren(parent, ...children) {
  for (const child of children) parent.appendChild(child);
  return parent;
}

function setDataset(el, values) {
  for (const [key, value] of Object.entries(values)) {
    el.dataset[key] = value == null ? '' : String(value);
  }
  return el;
}

function createSmallActionButton(text, dataset, disabled = false) {
  const btn = createEl('button', 'btn small', text);
  btn.type = 'button';
  btn.disabled = disabled;
  return setDataset(btn, dataset);
}

function createEmptyState(text) {
  return createEl('div', 'registry-empty', text);
}

const WORKLIST_STATUS_LABELS = {
  queued: '排队',
  preparing: '准备环境',
  running: '解题中',
  verifying: '验证中',
  solved: '已解出',
  failed: '失败',
  blocked: '阻塞',
  platform_closed: '平台关闭',
  stopped: '已停止',
};

const WORKLIST_ACTION_ICONS = {
  guide: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1.5"/></svg>',
  retry: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.8-3L3 11"/><path d="M3 5v6h6"/><path d="M4 13a8 8 0 0 0 14.8 3L21 13"/><path d="M21 19v-6h-6"/></svg>',
};

function createWorklistActionButton(action, title) {
  const button = createEl('button', 'worklist-item-action icon-btn ghost');
  button.type = 'button';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.dataset.worklistAction = action;
  button.innerHTML = WORKLIST_ACTION_ICONS[action] || '';
  return button;
}

async function guideWorklistItem(item) {
  const message = window.prompt(`向 ${item.name || item.exerciseId || '当前题目'} 提供解题引导`, '');
  if (!message || !message.trim()) return;
  await changeWorklist(() => bridgeApi.guideWorklist(item.id, message.trim()));
}

async function stopWorklistItem(item) {
  if (!window.confirm(`停止 ${item.name || item.exerciseId || '当前题目'} 的尝试？环境将保留，题目进入人工复核。`)) return;
  await changeWorklist(() => bridgeApi.stopWorklistItem(item.id));
}

async function retryWorklistItem(item) {
  await changeWorklist(() => bridgeApi.retryWorklist(item.id));
}

function renderWorklist(snapshot = {}) {
  if (!worklistListEl || !worklistSummaryEl) return;
  state.worklist = {
    ...state.worklist,
    ...snapshot,
    items: Array.isArray(snapshot.items) ? snapshot.items : state.worklist.items,
  };
  const items = Array.isArray(state.worklist.items) ? state.worklist.items : [];
  const running = state.worklist.running === true;
  const configured = state.worklist.configured === true;
  const mainControlled = state.worklist.managed === true || state.worklist.controller === 'Main Agent';
  const maxFlagAttempts = Number(state.worklist.maxFlagAttempts || 3);
  const maxFailures = Number(state.worklist.maxFailures || 2);
  worklistSummaryEl.textContent = !configured
    ? '未配置比赛凭证'
    : `${running ? '运行中' : '已停止'}${mainControlled ? ' · Main Agent 控制' : ''} · 环境 ${Number(state.worklist.activeEnvironmentCount || 0)}/${Number(state.worklist.maxEnvironmentCount || 3)} · 附件 ${Number(state.worklist.activeAttachmentCount || 0)} · flag尝试上限 ${maxFlagAttempts} · ${items.length} 题`;
  if (worklistToggleBtn) {
    worklistToggleBtn.title = mainControlled ? '工作列表由 Main Agent 控制' : (running ? '停止工作列表' : '启动工作列表');
    worklistToggleBtn.setAttribute('aria-label', worklistToggleBtn.title);
    worklistToggleBtn.disabled = !configured || mainControlled;
    worklistToggleBtn.innerHTML = running
      ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 5 11 7-11 7V5Z"/></svg>';
  }
  worklistSyncBtn.disabled = !configured || mainControlled;
  worklistListEl.textContent = '';
  if (!items.length) {
    worklistListEl.appendChild(createEl('div', 'worklist-empty', configured ? '暂无未解题目' : '配置凭证后自动同步'));
    return;
  }
  for (const item of items) {
    const status = String(item.status || 'queued');
    const solverSessionId = String(item.sessionId || item.metadata?.sessionId || item.metadata?.solverSessionId || '').trim();
    const row = createEl('div', 'worklist-item');
    row.dataset.status = status;
    const main = createEl('span', 'worklist-item-main');
    const mainButton = createEl('button', 'worklist-item-main-button');
    mainButton.type = 'button';
    mainButton.title = solverSessionId
      ? '打开对应 Pi 解题会话'
      : '该题尚未创建 solver，会话将打开 Main Agent';
    main.appendChild(createEl('span', 'worklist-item-name', `${item.exerciseId ?? ''} · ${item.name || '未命名题目'}`));
    const attemptBudget = Number(item.attemptBudget || item.metadata?.attemptBudget || maxFlagAttempts);
    main.appendChild(createEl('span', 'worklist-item-meta', `${item.category || 'unknown'} · ${item.requiresEnvironment ? '环境题' : '附件题'} · flag ${Number(item.attempts || 0)}/${attemptBudget} · 失败 ${Number(item.failures || 0)}/${maxFailures}${solverSessionId ? ' · Pi 会话' : ' · Main Agent'}`));
    mainButton.appendChild(main);
    mainButton.addEventListener('click', () => focusWorklistSession(item));
    row.appendChild(mainButton);
    const actions = createEl('span', 'worklist-item-actions');
    if (status !== 'solved') {
      const guideButton = createWorklistActionButton('guide', '人工引导');
      guideButton.addEventListener('click', () => guideWorklistItem(item));
      actions.appendChild(guideButton);
    }
    if (['preparing', 'running', 'verifying'].includes(status)) {
      const stopButton = createWorklistActionButton('stop', '停止尝试');
      stopButton.addEventListener('click', () => stopWorklistItem(item));
      actions.appendChild(stopButton);
    }
    if (['failed', 'blocked'].includes(status)) {
      const retryButton = createWorklistActionButton('retry', '重新排队');
      retryButton.addEventListener('click', () => retryWorklistItem(item));
      actions.appendChild(retryButton);
    }
    row.appendChild(actions);
    row.appendChild(createEl('span', 'worklist-item-status', WORKLIST_STATUS_LABELS[status] || status));
    worklistListEl.appendChild(row);
  }
}

async function loadWorklist() {
  if (!bridgeApi.getWorklist) return null;
  try {
    const result = await bridgeApi.getWorklist();
    renderWorklist(result);
    return result;
  } catch (error) {
    renderWorklist({ configured: false, items: [] });
    addDiagnostic('warn', '工作列表不可用', error);
    return null;
  }
}

function startWorklistRefresh() {
  if (worklistRefreshTimer) return;
  worklistRefreshTimer = window.setInterval(() => {
    if (state.bridgeReady && document.visibilityState === 'visible') loadWorklist();
  }, 3000);
}

async function changeWorklist(action) {
  try {
    const result = await action();
    renderWorklist(result);
  } catch (error) {
    showError(`工作列表操作失败：${error.message || error}`);
  }
}

function findMainAgentSession() {
  for (const sess of state.sessions.values()) {
    if (sess.role === 'main' && sess.bridgeSessionId) return sess;
  }
  return null;
}

async function focusWorklistSession(item) {
  const selectionVersion = ++state.sessionSelectionVersion;
  const sessionId = String(item?.sessionId || item?.metadata?.sessionId || item?.metadata?.solverSessionId || '').trim();
  if (!sessionId) {
    let main = findMainAgentSession();
    if (!main) {
      await refreshPersistedSessions();
      main = findMainAgentSession();
    }
    if (main && selectionVersion === state.sessionSelectionVersion) {
      setActiveSession(main.id);
      addDiagnostic('info', `题目 ${item?.exerciseId || item?.id || ''} 尚未创建 solver 会话，已打开 Main Agent。`);
      return;
    }
    showError('该题尚未创建 solver 会话，且当前未发现 Main Agent。');
    return;
  }
  try {
    const result = await bridgeApi.rpc('session/get', { sessionId });
    await activateCommandSession(result?.session || result, '', selectionVersion);
  } catch (error) {
    const sess = findSessionByBridgeId(sessionId);
    if (sess) {
      try {
        await hydrateSessionMessages(sess);
        if (selectionVersion === state.sessionSelectionVersion) setActiveSession(sess.id);
        return;
      } catch (fallbackError) {
        showError(`打开解题会话失败：${fallbackError.message || fallbackError}`);
        return;
      }
    }
    showError(`打开解题会话失败：${error.message || error}`);
  }
}

const composerPopupSelects = new Map();
let composerPopupSelectGlobalListenersReady = false;

function closeComposerPopupSelect(select, restoreFocus = false) {
  const popup = composerPopupSelects.get(select);
  if (!popup) return;
  popup.list.classList.add('hidden');
  popup.button.classList.remove('open');
  popup.button.setAttribute('aria-expanded', 'false');
  if (restoreFocus) popup.button.focus();
}

function closeAllComposerPopupSelects(exceptSelect = null) {
  for (const select of composerPopupSelects.keys()) {
    if (select !== exceptSelect) closeComposerPopupSelect(select);
  }
}

function composerPopupOptions(list) {
  return [...list.querySelectorAll('.composer-popup-select-option:not(:disabled)')];
}

function focusComposerPopupOption(list, direction = 1) {
  const options = composerPopupOptions(list);
  if (!options.length) return;
  const currentIndex = options.indexOf(document.activeElement);
  const nextIndex = currentIndex < 0
    ? (direction < 0 ? options.length - 1 : 0)
    : (currentIndex + direction + options.length) % options.length;
  options[nextIndex].focus();
}

function openComposerPopupSelect(select, focusDirection = 1) {
  const popup = composerPopupSelects.get(select);
  if (!popup || select.disabled) return;
  syncComposerPopupSelect(select);
  closeAllComposerPopupSelects(select);
  popup.list.classList.remove('hidden');
  popup.button.classList.add('open');
  popup.button.setAttribute('aria-expanded', 'true');
  const selected = popup.list.querySelector('[aria-selected="true"]');
  if (selected) selected.focus();
  else focusComposerPopupOption(popup.list, focusDirection);
}

function selectComposerPopupOption(select, value) {
  const popup = composerPopupSelects.get(select);
  if (!popup || select.disabled) return;
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  syncComposerPopupSelect(select);
  closeComposerPopupSelect(select, true);
}

function syncComposerPopupSelect(select) {
  const popup = composerPopupSelects.get(select);
  if (!popup) return;
  const selected = select.selectedOptions?.[0] || [...select.options].find((opt) => opt.value === select.value);
  const label = selected?.textContent?.trim() || popup.label;
  popup.button.textContent = label;
  popup.button.disabled = !!select.disabled;
  popup.button.title = select.title || popup.label;
  popup.button.setAttribute('aria-label', select.getAttribute('aria-label') || popup.label);
  if (select.disabled) closeComposerPopupSelect(select);
  popup.list.textContent = '';
  const options = [...select.options].filter((opt) => !opt.disabled && (opt.value || select.options.length === 1));
  options.forEach((opt, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.id = `${select.id || 'composer-popup-select'}-option-${index}`;
    item.className = 'composer-popup-select-option';
    item.role = 'option';
    item.textContent = opt.textContent || opt.value;
    item.dataset.value = opt.value;
    item.setAttribute('aria-selected', opt.value === select.value ? 'true' : 'false');
    item.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectComposerPopupOption(select, opt.value);
    });
    item.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusComposerPopupOption(popup.list, 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusComposerPopupOption(popup.list, -1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectComposerPopupOption(select, opt.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeComposerPopupSelect(select, true);
      } else if (event.key === 'Tab') {
        closeComposerPopupSelect(select);
      }
    });
    popup.list.appendChild(item);
  });
}

function setupComposerPopupSelect(select, label) {
  if (!select || composerPopupSelects.has(select)) return;
  select.classList.add('composer-popup-select-native');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'composer-popup-select-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const list = document.createElement('div');
  list.className = 'composer-popup-select-list hidden';
  list.role = 'listbox';
  select.insertAdjacentElement('afterend', button);
  button.insertAdjacentElement('afterend', list);
  composerPopupSelects.set(select, { button, list, label });
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (list.classList.contains('hidden')) openComposerPopupSelect(select);
    else closeComposerPopupSelect(select);
  });
  button.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openComposerPopupSelect(select, 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openComposerPopupSelect(select, -1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeComposerPopupSelect(select);
    }
  });
  if (!composerPopupSelectGlobalListenersReady) {
    composerPopupSelectGlobalListenersReady = true;
    document.addEventListener('click', (event) => {
      const target = event.target;
      const insidePopup = [...composerPopupSelects.values()].some((popup) => (
        popup.button.contains(target) || popup.list.contains(target)
      ));
      if (!insidePopup) closeAllComposerPopupSelects();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeAllComposerPopupSelects();
    });
  }
  syncComposerPopupSelect(select);
}

function clearDiagnostics() {
  const sess = state.sessions.get(state.activeId);
  if (sess) sess.diagnostics = [];
  renderDiagnostics();
}

// ─── Markdown ─────────────────────────────────────────────────────────────
if (typeof marked !== 'undefined') {
  marked.setOptions({
    gfm: true,
    breaks: true,
    mangle: false,
    headerIds: false
  });
}

const ALLOWED_URI_RE = /^(https?:|mailto:|tel:|#|\/)/i;

function renderMarkdown(text) {
  if (typeof marked === 'undefined') {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  try {
    return sanitizeMarkdown(marked.parse(text));
  } catch (e) {
    return escapeHtml(text);
  }
}

function sanitizeMarkdown(html) {
  const template = document.createElement('template');
  template.innerHTML = String(html);
  const blockedTags = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'BASE', 'FORM', 'INPUT', 'BUTTON']);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const removals = [];
  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (blockedTags.has(el.tagName)) {
      removals.push(el);
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on') || name === 'srcdoc') {
        el.removeAttribute(attr.name);
        continue;
      }
      if ((name === 'href' || name === 'src' || name === 'xlink:href') && value && !ALLOWED_URI_RE.test(value)) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === 'A') {
      el.setAttribute('rel', 'noopener noreferrer');
      el.setAttribute('target', '_blank');
    }
  }
  for (const el of removals) el.remove();
  return template.innerHTML;
}


function detectStructuredKind(line) {
  const trimmed = String(line || '').trim();
  const m = trimmed.match(/^(TOOL_RECALL|TOOL_REQUEST|TOOL_RESPONSE|COWORK|TUNR|TURN|ACTION|OBSERVATION|THOUGHT|TOOL)[\s:_-]*(.*)$/i);
  if (m) return { kind: m[1].toUpperCase(), rest: (m[2] || '').trim() };

  // SecHeur Agent's ACP bridge currently streams tool calls/results as plain
  // assistant text, not as ACP `tool_call` notifications. Recognize the real
  // XML-ish markers so streamed code_run/file_read/etc. blocks are folded.
  if (/^<function_calls\b[^>]*>/i.test(trimmed) || /^<invoke\b[^>]*\bname=["'][^"']+["'][^>]*>/i.test(trimmed)) {
    return { kind: 'TOOL_CALL', rest: trimmed };
  }
  if (/^<function_results\b[^>]*>/i.test(trimmed) || /^<result\b[^>]*>/i.test(trimmed)) {
    return { kind: 'TOOL_RESULT', rest: trimmed };
  }
  if (/^<sub_agent_call\b[^>]*>/i.test(trimmed)) {
    return { kind: 'SUB_AGENT_CALL', rest: trimmed };
  }
  if (/^<sub_agent_result\b[^>]*>/i.test(trimmed)) {
    return { kind: 'SUB_AGENT_RESULT', rest: trimmed };
  }
  if (/^<temp_sub_agent_dialog\b[^>]*>/i.test(trimmed)) {
    return { kind: 'TEMP_SUB_AGENT_DIALOG', rest: trimmed };
  }
  return null;
}

function isStructuredClosingLine(line, kind, textSoFar) {
  const trimmed = String(line || '').trim();
  const block = String(textSoFar || '');
  if (kind === 'TOOL_CALL') {
    if (/^<\/function_calls>$/i.test(trimmed)) return true;
    // Single-invoke streams may omit the <function_calls> wrapper.
    return /^<\/invoke>$/i.test(trimmed) && !/^\s*<function_calls\b/im.test(block);
  }
  if (kind === 'TOOL_RESULT') {
    if (/^<\/function_results>$/i.test(trimmed)) return true;
    // Single-result streams may omit the <function_results> wrapper.
    return /^<\/result>$/i.test(trimmed) && !/^\s*<function_results\b/im.test(block);
  }
  if (kind === 'SUB_AGENT_CALL') return /^<\/sub_agent_call>$/i.test(trimmed);
  if (kind === 'SUB_AGENT_RESULT') return /^<\/sub_agent_result>$/i.test(trimmed);
  if (kind === 'TEMP_SUB_AGENT_DIALOG') return /^<\/temp_sub_agent_dialog>$/i.test(trimmed);
  return false;
}

const EXECUTION_STAGE_LABELS = {
  LLM_RUNNING: '正在思考下一步',
  thinking: '正在思考下一步',
  agent_thought_chunk: '正在思考下一步',
  response: '正在整理结果',
  agent_message_chunk: '正在整理结果',
  TOOL_RESULT: '工具已返回结果',
  Result: '工具已返回结果',
  SUB_AGENT_CALL: '正在让子智能体处理任务',
  TEMP_SUB_AGENT_DIALOG: '正在让子智能体处理任务',
  子智能体调用: '正在让子智能体处理任务',
  临时智能体: '正在让子智能体处理任务',
  SUB_AGENT_RESULT: '子智能体返回结果',
  子智能体对话: '子智能体返回结果',
};

const TOOL_STAGE_RULES = [
  [/\b(file_read|grep_search|list_files|file_search|file_fetch)\b/i, '正在查看项目文件'],
  [/\b(code_run|bash|shell|terminal|python|node)\b/i, '正在执行命令'],
  [/\b(web_fetch|web_search|browser|fetch)\b/i, '正在查看网页'],
  [/\bmcp/i, '正在调用外部工具'],
];

function toolExecutionStageLabel(text) {
  const raw = String(text || '');
  const match = TOOL_STAGE_RULES.find(([pattern]) => pattern.test(raw));
  return match ? match[1] : '准备调用工具';
}

function executionStageLabel(kind, text = '') {
  const stage = String(kind || '').trim();
  if (stage === 'TOOL_CALL' || stage === 'Tool') return toolExecutionStageLabel(text);
  return EXECUTION_STAGE_LABELS[stage] || stage || '正在处理';
}

function summarizeStructuredBlock(kind, text) {
  const raw = String(text || '');
  // For all kinds: prefer <summary> tag content only
  const summary = extractTagBody(raw, 'summary');
  if (summary) {
    const line = summary.split('\n')[0] || kind;
    return line.length > 96 ? line.slice(0, 96) + '…' : line;
  }
  // No summary tag: show kind only (no body text leakage)
  return executionStageLabel(kind, raw);
}

function turnNarrativeForSegment(seg) {
  const kind = String(seg?.kind || '');
  if (!['LLM_RUNNING', 'agent_thought_chunk', 'thinking'].includes(kind)) return '';
  const raw = String(seg.text || '');
  const summary = extractTagBody(raw, 'summary');
  if (summary) return summary;
  if (kind !== 'LLM_RUNNING') return '';
  const withoutMarker = raw
    .replace(/\**LLM Running \(Turn \d+\) \.\.\.\**/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  const toolStart = withoutMarker.search(/^\s*(?:<function_calls\b|<invoke\b|🛠️|TOOL_(?:RECALL|REQUEST|RESPONSE)\b|ACTION\b)/im);
  return (toolStart >= 0 ? withoutMarker.slice(0, toolStart) : withoutMarker).trim();
}

function syncTurnNarrative(turn, kind, text) {
  if (!turn) return;
  const narrative = turnNarrativeForSegment({ kind, text });
  let narrativeEl = turn.querySelector(':scope > .turn-narrative');
  if (!narrative) {
    narrativeEl?.remove();
    return;
  }
  if (!narrativeEl) {
    narrativeEl = document.createElement('div');
    narrativeEl.className = 'turn-narrative md';
    turn.insertBefore(narrativeEl, turn.querySelector(':scope > .turn-body'));
  }
  narrativeEl.innerHTML = renderMarkdown(narrative);
}

const LLM_RUNNING_MARKER_RE = /(\**LLM Running \(Turn \d+\) \.\.\.\**)/g;

function splitLLMRunningSegments(raw) {
  const placeholders = [];
  const protect = value => {
    placeholders.push(value);
    return `\u0000PH${placeholders.length - 1}\u0000`;
  };
  let safe = String(raw || '').replace(/`{4,}[\s\S]*?`{4,}/g, protect);
  safe = safe.replace(/`{4,}[^`][\s\S]*$/g, protect);
  const restore = value => String(value || '').replace(/\u0000PH(\d+)\u0000/g, (_, i) => placeholders[Number(i)] || '');
  const parts = safe.split(LLM_RUNNING_MARKER_RE).map(restore);
  if (parts.length < 4) return null;
  const segments = [];
  if (parts[0] && parts[0].trim()) segments.push({ kind: 'agent_message_chunk', text: parts[0].trimEnd() });
  const turns = [];
  for (let i = 1; i < parts.length; i += 2) {
    turns.push({ marker: parts[i] || '', content: parts[i + 1] || '' });
  }
  turns.forEach((turn, idx) => {
    const text = `${turn.marker}${turn.content}`.trimEnd();
    if (!text) return;
    // Match Streamlit: historical/intermediate LLM Running turns are folded;
    // the latest turn remains plain so final answers are not hidden by default.
    segments.push({ kind: idx < turns.length - 1 ? 'LLM_RUNNING' : 'agent_message_chunk', text });
  });
  return segments.length ? segments : null;
}

function splitStructuredSegments(text) {
  const raw = String(text || '');
  const llmSegments = /<(?:sub_agent_(?:call|result)|temp_sub_agent_dialog)\b/i.test(raw) ? null : splitLLMRunningSegments(raw);
  if (llmSegments) return llmSegments;
  const lines = raw.split(/\r?\n/);
  const segments = [];
  let buf = [];
  let kind = 'agent_message_chunk';
  let inFence = false;
  const flush = () => {
    if (!buf.length) return;
    segments.push({ kind, text: buf.join('\n').trimEnd() });
    buf = [];
  };
  for (const line of lines) {
    const fence = /^\s*```/.test(line);
    const hit = !inFence ? detectStructuredKind(line) : null;
    if (hit && hit.kind !== kind) {
      flush();
      kind = hit.kind;
      buf.push(line);
    } else {
      buf.push(line);
    }
    if (!inFence && kind !== 'agent_message_chunk' && isStructuredClosingLine(line, kind, buf.join('\n'))) {
      flush();
      kind = 'agent_message_chunk';
    }
    if (fence) inFence = !inFence;
  }
  flush();
  return segments.length ? segments : [{ kind: 'agent_message_chunk', text: raw }];
}

function hasUnfencedStructuredMarker(text) {
  let inFence = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    const fence = /^\s*```/.test(line);
    if (!inFence && detectStructuredKind(line)) return true;
    if (fence) inFence = !inFence;
  }
  return false;
}

function shouldFoldSegment(kind, text) {
  return kind !== 'agent_message_chunk' || hasUnfencedStructuredMarker(text);
}

function getNowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return Math.round(performance.now());
  return Date.now();
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return `${Math.max(1, Math.round(value))}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatTaskElapsedPlain(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (hours || minutes) parts.push(`${minutes}min`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function formatTaskElapsed(ms, ended) {
  const elapsed = formatTaskElapsedPlain(ms);
  if (ended) return `完成 · ${elapsed}`;
  const spinner = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  const frame = spinner[Math.floor(Date.now() / 1000) % spinner.length];
  return `${frame} 运行中 · ${elapsed}`;
}

function taskElapsedAccessibleLabel(ms, ended) {
  const elapsed = formatTaskElapsedPlain(ms);
  return ended ? `任务完成，用时 ${elapsed}` : `任务运行中，用时 ${elapsed}`;
}

function getSessionRuntime(sess) {
  if (!sess) return null;
  const sessionId = sess.id;
  let runtime = state.runtimeBySessionId.get(sessionId);
  if (!runtime) {
    runtime = {
      busy: false,
      currentTurnEl: null,
      lastMessageType: null,
      taskStartedAt: 0,
      taskTimerId: null,
      assistantDraft: null,
      currentStageText: '',
      currentStageKind: '',
      lastAssistantActivityAt: 0,
      stalledNoticeShown: false,
      structuredTurnDisclosureState: new Map(),
      conversationToolRecords: new Map(),
      conversationToolSyncTimer: 0,
      conversationToolSyncSerial: 0,
      messagesLoaded: false,
      messagesLoading: false,
      messagesHydrationPromise: null,
      messagesHydrationPollQueued: false,
      historyTruncated: false,
      pollWakeResolver: null,
      pollWakeVersion: 0,
      pollObservedWakeVersion: 0,
    };
    state.runtimeBySessionId.set(sessionId, runtime);
  }
  return runtime;
}

function getActiveSessionRuntime() {
  const sess = state.sessions.get(state.activeId);
  return sess ? getSessionRuntime(sess) : null;
}

function structuredRenderOptionsForSession(sess, busy = false) {
  const runtime = getSessionRuntime(sess);
  return {
    disclosureState: runtime?.structuredTurnDisclosureState,
    busy: !!busy
  };
}

function renderComposerActivity() {
  if (!composerActivityEl || !composerActivityTextEl) return;
  const runtime = getActiveSessionRuntime();
  const composerBusy = !!(state.attachmentSelectionBusy || runtime?.busy);
  if (composerEl) composerEl.setAttribute('aria-busy', composerBusy ? 'true' : 'false');
  if (state.composerNoticeText) {
    composerActivityTextEl.textContent = state.composerNoticeText;
    composerActivityEl.classList.remove('hidden');
    composerActivityEl.dataset.kind = 'notice';
    return;
  }
  if (state.attachmentSelectionBusy) {
    composerActivityTextEl.textContent = '正在读取附件…';
    composerActivityEl.classList.remove('hidden');
    composerActivityEl.dataset.kind = 'attachment';
    return;
  }
  if (runtime?.busy) {
    const label = runtime.currentStageText || '正在处理请求…';
    composerActivityTextEl.textContent = '';
    composerActivityEl.classList.add('hidden');
    composerActivityEl.dataset.kind = runtime.currentStageKind || 'running';
    composerActivityEl.setAttribute('aria-label', label);
    return;
  }
  composerActivityTextEl.textContent = '';
  composerActivityEl.classList.add('hidden');
  delete composerActivityEl.dataset.kind;
}

function flashComposerNotice(text, timeout = 2600) {
  state.composerNoticeText = String(text || '');
  if (state.composerNoticeTimer) clearTimeout(state.composerNoticeTimer);
  renderComposerActivity();
  state.composerNoticeTimer = setTimeout(() => {
    state.composerNoticeText = '';
    state.composerNoticeTimer = null;
    renderComposerActivity();
  }, timeout);
}

function updateSessionStage(sess, label, kind = '') {
  const runtime = sess ? getSessionRuntime(sess) : null;
  if (!runtime || !label) return;
  runtime.currentStageText = label;
  runtime.currentStageKind = kind || '';
  if (!isActiveSession(sess)) return;
  setStatus('busy', label);
  renderComposerActivity();
}

function clearSessionStage(sess) {
  const runtime = sess ? getSessionRuntime(sess) : null;
  if (!runtime) return;
  runtime.currentStageText = '';
  runtime.currentStageKind = '';
  if (isActiveSession(sess)) renderComposerActivity();
}

function markAssistantActivity(sess) {
  const runtime = sess ? getSessionRuntime(sess) : null;
  if (!runtime) return;
  runtime.lastAssistantActivityAt = getNowMs();
  runtime.stalledNoticeShown = false;
}

function maybeWarnModelStall(sess, result = {}) {
  const runtime = sess ? getSessionRuntime(sess) : null;
  if (!runtime?.busy || runtime.stalledNoticeShown) return;
  const now = getNowMs();
  const startedAt = Number(runtime.taskStartedAt || 0);
  if (!startedAt) return;
  const partialContent = String(result?.partial?.content || '');
  const hasAssistantText = !!(partialContent || runtime.assistantDraft?.text);
  const lastActivityAt = Number(runtime.lastAssistantActivityAt || 0);
  const idleMs = hasAssistantText && lastActivityAt ? now - lastActivityAt : now - startedAt;
  const limitMs = hasAssistantText ? MODEL_IDLE_WARNING_MS : MODEL_FIRST_OUTPUT_WARNING_MS;
  if (idleMs < limitMs) return;
  const label = hasAssistantText
    ? `模型输出已 ${formatDuration(idleMs)} 没有更新，可能卡在流式连接、工具返回或服务端响应`
    : `等待模型首个输出超过 ${formatDuration(idleMs)}，可能卡在 API 请求、代理、API Base 或模型配置`;
  runtime.currentStageText = label;
  runtime.currentStageKind = 'stalled';
  runtime.stalledNoticeShown = true;
  if (!isActiveSession(sess)) return;
  setStatus('warn', label);
  renderComposerActivity();
  showError(label, '重置运行时', () => resetActiveSessionRuntime(sess), { persist: true });
}

async function resetActiveSessionRuntime(sess = state.sessions.get(state.activeId)) {
  if (!sess) return null;
  const runtime = getSessionRuntime(sess);
  const result = await bridgeApi.rpc('session/runtime/reset', { sessionId: sess.bridgeSessionId || sess.id });
  if (result?.error) throw new Error(result.error.message || result.error);
  runtime.busy = false;
  runtime.currentTurnEl = null;
  runtime.assistantDraft = null;
  runtime.taskStartedAt = 0;
  runtime.lastAssistantActivityAt = 0;
  runtime.stalledNoticeShown = false;
  runtime.currentStageText = '';
  runtime.currentStageKind = '';
  sess.piSlashCommands = null;
  void loadSessionSlashCommands(sess, { force: true });
  addDiagnostic('info', '已重置本对话运行时', result);
  if (isActiveSession(sess)) {
    hideError();
    flashComposerNotice('已重置运行时，下一条消息会使用新的 Agent。');
  }
  return result;
}

function findSessionByBridgeId(bridgeSessionId) {
  if (!bridgeSessionId) return state.sessions.get(state.activeId) || null;
  for (const sess of state.sessions.values()) {
    if (sess.bridgeSessionId === bridgeSessionId || sess.id === bridgeSessionId) return sess;
  }
  return null;
}

function bridgeSessionIdFromPayload(payload) {
  return payload?.id || payload?.sessionId || payload?.bridgeSessionId || '';
}

function applyBridgeSessionSnapshot(sess, snapshot = {}, config = null) {
  if (!sess) return null;
  const bridgeSessionId = bridgeSessionIdFromPayload(snapshot);
  if (bridgeSessionId) sess.bridgeSessionId = bridgeSessionId;
  if (snapshot.title && sess.title !== snapshot.title) {
    sess.title = snapshot.title;
    sess.untitled = isUntitledSessionTitle(snapshot.title);
    if (sessionTitleEl && isActiveSession(sess)) sessionTitleEl.textContent = sess.title;
  }
  if (snapshot.cwd) sess.cwd = snapshot.cwd;
  if (snapshot.role) sess.role = snapshot.role;
  if (snapshot.planningEngine) sess.planningEngine = snapshot.planningEngine;
  if (snapshot.executionMode) sess.executionMode = snapshot.executionMode;
  if (snapshot.managed !== undefined) sess.managed = snapshot.managed === true;
  if (snapshot.taskId) sess.taskId = snapshot.taskId;
  if (snapshot.category) sess.category = snapshot.category;
  if (snapshot.parentMainSessionId) sess.parentMainSessionId = snapshot.parentMainSessionId;
  if (snapshot.tmuxTarget) sess.tmuxTarget = snapshot.tmuxTarget;
  if (Number.isFinite(Number(snapshot.createdAt))) sess.createdAt = Number(snapshot.createdAt);
  if (Number.isFinite(Number(snapshot.updatedAt))) {
    const snapshotUpdatedAt = Number(snapshot.updatedAt);
    sess.updatedAt = Math.max(Number(sess.updatedAt || 0), snapshotUpdatedAt);
  }
  if (Number.isFinite(Number(snapshot.msgSeq))) sess.bridgeMsgSeq = Number(snapshot.msgSeq);
  if (config) sess.config = { ...sess.config, ...config };
  if (snapshot.llmNo !== undefined) sess.config.llmNo = Number(snapshot.llmNo || 0);
  if (snapshot.permissionMode) sess.config.permissionMode = snapshot.permissionMode;
  if (snapshot.memoryReferenceEnabled !== undefined) sess.config.memoryReferenceEnabled = snapshot.memoryReferenceEnabled !== false;
  if (snapshot.knowledgeBaseEnabled !== undefined) {
    sess.config.knowledgeBaseEnabled = snapshot.knowledgeBaseEnabled === true;
  }
  if (snapshot.blackboardGraph) sess.blackboardGraph = snapshot.blackboardGraph;
  if (snapshot.status === 'running' || snapshot.partial) getSessionRuntime(sess).busy = true;
  else if (snapshot.status === 'idle' || snapshot.status === 'error') getSessionRuntime(sess).busy = false;
  return sess;
}

function upsertLocalSessionForBridgeSession(snapshot = {}, fallbackTitle = '后台会话', config = null) {
  if (shouldIgnoreBridgeSessionSnapshot(snapshot)) return null;
  const bridgeSessionId = bridgeSessionIdFromPayload(snapshot);
  if (!bridgeSessionId) return null;
  let sess = findSessionByBridgeId(bridgeSessionId);
  if (sess) return applyBridgeSessionSnapshot(sess, snapshot, config);
  const localId = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  sess = createLocalSession(localId, snapshot.title || fallbackTitle, bridgeSessionId, config);
  return applyBridgeSessionSnapshot(sess, snapshot, config);
}

function ensureSessionForBridgeNotification(msg) {
  if (!msg || !msg.sessionId) return null;
  if (shouldIgnoreBridgeSessionSnapshot(msg)) return null;
  // Solver 是后台 worker：先更新轻量状态列表，只有用户点击后才载入完整会话。
  if (String(msg.role || '').toLowerCase() === 'solver') {
    rememberSolverSnapshot(msg);
    if (!findSessionByBridgeId(msg.sessionId)) return null;
  }
  return upsertLocalSessionForBridgeSession(msg, msg.title || '后台会话');
}

function rememberClosedSession(sess, localId = '') {
  const sessionId = localId || sess?.id || '';
  const bridgeSessionId = sess?.bridgeSessionId || '';
  if (sessionId) state.closedSessionIds.add(sessionId);
  if (bridgeSessionId) state.closedBridgeSessionIds.add(bridgeSessionId);
}

function isClosedSessionId(sessionId) {
  return !!sessionId && state.closedSessionIds.has(sessionId);
}

function isClosedBridgeSessionId(bridgeSessionId) {
  return !!bridgeSessionId && state.closedBridgeSessionIds.has(bridgeSessionId);
}

function isOfflineSelfTestSessionSnapshot(snapshot = {}) {
  return String(snapshot.title || '').trim() === 'self-test prompt'
    && Number(snapshot.msgSeq || 0) === 2
    && snapshot.persistent !== false;
}

function shouldIgnoreBridgeSessionSnapshot(snapshot = {}) {
  const bridgeSessionId = bridgeSessionIdFromPayload(snapshot);
  const localSessionId = snapshot.localId || snapshot.localSessionId || '';
  return isClosedBridgeSessionId(bridgeSessionId)
    || isClosedSessionId(localSessionId)
    || isOfflineSelfTestSessionSnapshot(snapshot);
}

function sessionOrderKey(value) {
  if (typeof value === 'string') return value;
  return String(value?.bridgeSessionId || value?.sessionId || value?.id || '').trim();
}

function recordSessionPosition(value, move = false) {
  const key = sessionOrderKey(value);
  if (!key) return;
  if (!state.sessionPositions.has(key) || move) {
    state.sessionPositions.set(key, ++state.nextSessionPosition);
  }
}

function forgetSessionPosition(value) {
  const key = sessionOrderKey(value);
  if (key) state.sessionPositions.delete(key);
}

function initializeSessionOrder(snapshots = []) {
  let savedOrder = [];
  try {
    const saved = JSON.parse(localStorage.getItem('secheur:session-order') || '[]');
    if (Array.isArray(saved)) savedOrder = saved.filter((id) => typeof id === 'string');
  } catch (_) { /* 存储不可用时保留本页顺序。 */ }
  const available = new Set(snapshots.map(sessionOrderKey));
  const keys = [...new Set([...savedOrder.filter((id) => available.has(id)), ...available])];
  // 只初始化未知会话的顺序，后台时间戳不参与后续排序。
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    recordSessionPosition(keys[index]);
  }
}

function persistSessionOrder() {
  const keys = [...state.sessionPositions.keys()].sort((left, right) => (
    state.sessionPositions.get(right) - state.sessionPositions.get(left)
  ));
  try { localStorage.setItem('secheur:session-order', JSON.stringify(keys)); }
  catch (_) { /* 存储不可用不影响本页操作。 */ }
}

function sortSessionsByPosition() {
  const entries = [...state.sessions.entries()];
  entries.sort((left, right) => {
    const leftSession = left[1];
    const rightSession = right[1];
    const leftPosition = state.sessionPositions.get(sessionOrderKey(leftSession));
    const rightPosition = state.sessionPositions.get(sessionOrderKey(rightSession));
    return Number(rightPosition || 0) - Number(leftPosition || 0)
      || String(rightSession.id || '').localeCompare(String(leftSession.id || ''));
  });
  state.sessions = new Map(entries);
}

function solverStatusKind(snapshot = {}) {
  const status = String(snapshot.status || snapshot.state || '').toLowerCase();
  if (snapshot.partial || status === 'running') return 'running';
  if (status === 'error') return 'error';
  if (status === 'stopped') return 'stopped';
  if (status === 'starting') return 'starting';
  return 'idle';
}

function solverStatusLabel(snapshot = {}) {
  const labels = {
    running: '运行中',
    error: '错误',
    stopped: '已停止',
    starting: '启动中',
    idle: '空闲',
  };
  return labels[solverStatusKind(snapshot)] || labels.idle;
}

let solverListRenderQueued = false;

function scheduleSolverListRender() {
  if (solverListRenderQueued) return;
  solverListRenderQueued = true;
  const flush = () => {
    solverListRenderQueued = false;
    renderSolverList();
  };
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(flush);
  else window.setTimeout(flush, 0);
}

function rememberSolverSnapshot(snapshot = {}) {
  const bridgeSessionId = String(bridgeSessionIdFromPayload(snapshot) || '').trim();
  if (!bridgeSessionId || shouldIgnoreBridgeSessionSnapshot(snapshot)) return;
  const current = state.solverSessions.get(bridgeSessionId) || {};
  const next = {
    ...current,
    ...snapshot,
    id: bridgeSessionId,
    sessionId: bridgeSessionId,
    role: 'solver',
  };
  if (snapshot.status === undefined && snapshot.state !== undefined) next.status = snapshot.state;
  state.solverSessions.set(bridgeSessionId, next);
  recordSessionPosition(bridgeSessionId);
  scheduleSolverListRender();
}

function renderSolverList() {
  if (!solverSectionEl || !solverListEl || !solverSummaryCountEl) return;
  const snapshots = [...state.solverSessions.values()].sort((left, right) => (
    Number(state.sessionPositions.get(sessionOrderKey(right)) || 0)
      - Number(state.sessionPositions.get(sessionOrderKey(left)) || 0)
      || String(left.title || left.sessionId || '').localeCompare(String(right.title || right.sessionId || ''))
  ));
  const hasSolvers = snapshots.length > 0;
  solverSectionEl.classList.toggle('hidden', !hasSolvers);
  solverSectionEl.setAttribute('aria-hidden', hasSolvers ? 'false' : 'true');
  solverSummaryCountEl.textContent = String(snapshots.length);
  solverListEl.textContent = '';
  for (const snapshot of snapshots) {
    const bridgeSessionId = String(bridgeSessionIdFromPayload(snapshot) || '').trim();
    if (!bridgeSessionId) continue;
    const opened = findSessionByBridgeId(bridgeSessionId);
    const statusKind = solverStatusKind(snapshot);
    const row = createEl('button', 'solver-row');
    row.type = 'button';
    row.dataset.sessionId = bridgeSessionId;
    row.dataset.status = statusKind;
    row.classList.toggle('active', !!opened && isActiveSession(opened));
    const title = String(snapshot.title || snapshot.taskId || bridgeSessionId).trim();
    const category = String(snapshot.category || '').trim();
    const taskId = String(snapshot.taskId || '').trim();
    const meta = [category, taskId].filter(Boolean).join(' · ') || '后台任务';
    const status = solverStatusLabel(snapshot);
    row.title = `${title} · ${status} · 点击后按需加载会话`;
    row.setAttribute('aria-label', row.title);
    const icon = createEl('span', 'solver-row-icon');
    icon.innerHTML = projectShieldIconSvg(15);
    icon.setAttribute('aria-hidden', 'true');
    const content = createEl('span', 'solver-row-content');
    content.appendChild(createEl('span', 'solver-row-name', title));
    content.appendChild(createEl('span', 'solver-row-meta', meta));
    row.appendChild(icon);
    row.appendChild(content);
    row.appendChild(createEl('span', 'solver-row-status', status));
    row.addEventListener('click', () => {
      openSolverSession(state.solverSessions.get(bridgeSessionId) || snapshot);
    });
    solverListEl.appendChild(row);
  }
}

function openSolverSession(snapshot = {}) {
  const bridgeSessionId = String(bridgeSessionIdFromPayload(snapshot) || '').trim();
  if (!bridgeSessionId) return;
  let sess = findSessionByBridgeId(bridgeSessionId);
  if (!sess) sess = upsertLocalSessionForBridgeSession(snapshot, snapshot.title || 'Solver');
  if (!sess) return;
  setActiveSession(sess.id);
  const runtime = getSessionRuntime(sess);
  runtime.forcePollOnce = true;
  void pollSessionMessages(sess);
}

let sessionListRefreshTimer = 0;
let sessionListRefreshPromise = null;
let sessionListVisibilityListenerReady = false;
let worklistRefreshTimer = 0;

async function refreshPersistedSessions() {
  if (!state.bridgeReady) return null;
  if (sessionListRefreshPromise) return sessionListRefreshPromise;
  sessionListRefreshPromise = (async () => {
    // 获取 solver 元数据用于轻量列表；未打开的 solver 不进入对话 state，也不轮询 transcript。
    const result = await bridgeApi.rpc('session/list', { includeSolvers: true });
    const snapshots = Array.isArray(result?.sessions) ? result.sessions : [];
    const solverSnapshots = snapshots.filter((snapshot) => String(snapshot?.role || '').toLowerCase() === 'solver');
    state.solverSessions = new Map(
      solverSnapshots
        .filter((snapshot) => !shouldIgnoreBridgeSessionSnapshot(snapshot))
        .map((snapshot) => [bridgeSessionIdFromPayload(snapshot), snapshot]),
    );
    // 首次发现后台 Solver 时保留 bridge 返回的顺序，后续只更新摘要。
    for (let index = solverSnapshots.length - 1; index >= 0; index -= 1) {
      const snapshot = solverSnapshots[index];
      const bridgeSessionId = bridgeSessionIdFromPayload(snapshot);
      if (!bridgeSessionId || shouldIgnoreBridgeSessionSnapshot(snapshot)) continue;
      recordSessionPosition(bridgeSessionId);
    }
    renderSolverList();
    const openedSolverIds = new Set(
      [...state.sessions.values()]
        .filter((sess) => sess.role === 'solver')
        .map((sess) => sess.bridgeSessionId || sess.id),
    );
    for (const snapshot of [...snapshots].reverse()) {
      const bridgeSessionId = bridgeSessionIdFromPayload(snapshot);
      const isSolver = String(snapshot?.role || '').toLowerCase() === 'solver';
      if (isSolver && !openedSolverIds.has(bridgeSessionId)) continue;
      const sess = upsertLocalSessionForBridgeSession(snapshot, snapshot.title || 'Restored');
      if (!sess) continue;

      if (sess.role === 'solver' && !isActiveSession(sess)) continue;
      const runtime = getSessionRuntime(sess);
      const snapshotSeq = Number(snapshot.msgSeq || 0);
      const lastPolledId = Number(runtime.lastPolledMessageId || 0);
      if (snapshotSeq < lastPolledId) {
        sess.messages = [];
        runtime.seenBridgeMessageIds = new Set();
        runtime.lastPolledMessageId = 0;
        runtime.assistantDraft = null;
        _domCache.delete(sess.id);
      }
      // 非活动会话只同步轻量摘要；只有当前会话或确实正在运行的会话才启动
      // transcript 轮询，避免 15 个 Solver 在后台各自拉取完整历史。
      if ((isActiveSession(sess) || runtime.busy)
        && snapshotSeq > Number(runtime.lastPolledMessageId || 0)
        && !runtime.polling) {
        runtime.forcePollOnce = true;
        pollSessionMessages(sess);
      }
    }
    renderSessionList();
    const conversationSnapshots = snapshots.filter(
      (snapshot) => String(snapshot?.role || '').toLowerCase() !== 'solver',
    );
    if (!state.activeId && conversationSnapshots.length > 0) {
      const first = findSessionByBridgeId(bridgeSessionIdFromPayload(conversationSnapshots[0]));
      if (first) setActiveSession(first.id);
    }
    return result;
  })().catch((error) => {
    console.warn('Session list refresh failed:', error);
    return null;
  }).finally(() => {
    sessionListRefreshPromise = null;
  });
  return sessionListRefreshPromise;
}

function startPersistedSessionRefresh() {
  if (!sessionListRefreshTimer) {
    sessionListRefreshTimer = window.setInterval(refreshPersistedSessions, SESSION_LIST_REFRESH_MS);
  }
  if (!sessionListVisibilityListenerReady) {
    sessionListVisibilityListenerReady = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshPersistedSessions();
    });
  }
}

function isBridgeSessionNotFoundError(err) {
  const detail = [
    err?.message,
    err?.data?.error,
    err?.data?.message,
    err?.data?.raw,
  ].filter(Boolean).join(' ');
  return Number(err?.status || 0) === 404 && /session not found/i.test(detail);
}

function clearStaleBridgeSession(sess, err = null, attemptedSessionId = '') {
  if (!sess) return;
  const staleId = attemptedSessionId || sess.bridgeSessionId || '';
  if (!attemptedSessionId || sess.bridgeSessionId === attemptedSessionId) {
    sess.bridgeSessionId = null;
  }
  addDiagnostic('warn', `后端会话已失效，清理本地 session 映射${staleId ? `：${staleId}` : ''}`, err);
}

function isActiveSession(sess) {
  return !!sess && sess.id === state.activeId;
}

function withSessionDom(sess, fn) {
  if (isActiveSession(sess)) return fn();
  return null;
}

function updateTaskRuntimeBadges(now = getNowMs()) {
  const badges = document.querySelectorAll('.task-elapsed[data-started-at]');
  badges.forEach((badge) => {
    const startedAt = Number(badge.dataset.startedAt || 0);
    if (startedAt) {
      const elapsedMs = now - startedAt;
      const label = taskElapsedAccessibleLabel(elapsedMs, false);
      badge.textContent = formatTaskElapsed(elapsedMs);
      badge.setAttribute('aria-label', label);
      badge.title = label;
    }
  });
}

function clearTaskTimer(sess) {
  const runtime = sess ? getSessionRuntime(sess) : getActiveSessionRuntime();
  if (runtime?.taskTimerId) {
    clearInterval(runtime.taskTimerId);
    runtime.taskTimerId = null;
  }
}

function startTaskTimer(sess, startedAt = getNowMs()) {
  const runtime = getSessionRuntime(sess);
  clearTaskTimer(sess);
  runtime.taskStartedAt = Number(startedAt) || getNowMs();
  runtime.lastAssistantActivityAt = 0;
  runtime.stalledNoticeShown = false;
  if (isActiveSession(sess)) updateTaskRuntimeBadges(runtime.taskStartedAt);
  runtime.taskTimerId = setInterval(() => {
    if (isActiveSession(sess)) {
      updateTaskRuntimeBadges();
      renderComposerActivity();
    }
  }, 1000);
}

function stopTaskTimer(sess) {
  if (isActiveSession(sess)) updateTaskRuntimeBadges();
  const runtime = getSessionRuntime(sess);
  clearTaskTimer(sess);
  runtime.taskStartedAt = 0;
}

function taskElapsedBadge(startedAt, endedAt) {
  const start = Number(startedAt || 0);
  if (!start) return '';
  const end = Number(endedAt || 0);
  const now = end || getNowMs();
  const ended = !!end;
  const liveAttr = ended ? 'data-ended="1"' : `data-started-at="${escapeHtml(String(start))}"`;
  const elapsedMs = now - start;
  const label = taskElapsedAccessibleLabel(elapsedMs, ended);
  return `<span class="task-elapsed" ${liveAttr} aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${escapeHtml(formatTaskElapsed(elapsedMs, ended))}</span>`;
}

function ensureAssistantTaskElapsed(wrap, startedAt, endedAt) {
  if (!wrap) return null;
  const html = taskElapsedBadge(startedAt, endedAt);
  let badge = wrap.querySelector(':scope > .task-elapsed');
  if (!html) {
    badge?.remove();
    return null;
  }
  if (!badge) {
    wrap.insertAdjacentHTML('afterbegin', html);
    badge = wrap.querySelector(':scope > .task-elapsed');
  } else {
    const holder = document.createElement('div');
    holder.innerHTML = html;
    badge.replaceWith(holder.firstElementChild);
    badge = wrap.querySelector(':scope > .task-elapsed');
  }
  return badge;
}

const STAGE_ONLY_SEGMENT_KINDS = new Set([
  'TOOL_CALL',
  'TOOL_RESULT',
  'SUB_AGENT_CALL',
  'SUB_AGENT_RESULT',
  'TEMP_SUB_AGENT_DIALOG',
]);

function turnLabelForSegment(seg, index) {
  const summary = summarizeStructuredBlock(seg.kind, seg.text);
  if (seg.kind === 'LLM_RUNNING') return executionStageLabel(seg.kind, seg.text) || `Turn ${index + 1}`;
  if (STAGE_ONLY_SEGMENT_KINDS.has(seg.kind)) return executionStageLabel(seg.kind, seg.text);
  return summary || seg.kind || `Turn ${index + 1}`;
}

function nextTurnIndexForWrap(wrap) {
  const current = Number(wrap?.dataset?.turnIndex || 0) || 0;
  const next = current + 1;
  if (wrap) wrap.dataset.turnIndex = String(next);
  return next;
}

function turnHeaderLabel(index, label) {
  return `步骤 ${index}：${executionStageLabel(label)}`;
}

function groupIntoTurns(segments, options = {}) {
  let foldIndex = 0;
  const grouped = [];
  for (const seg of segments || []) {
    if (!shouldFoldSegment(seg.kind, seg.text)) {
      grouped.push({ type: 'plain', segment: seg });
      continue;
    }
    const index = ++foldIndex;
    grouped.push({
      type: 'turn',
      index,
      label: turnLabelForSegment(seg, index - 1),
      segment: seg
    });
    const narrative = turnNarrativeForSegment(seg);
    if (narrative) grouped.push({ type: 'plain', segment: { kind: 'agent_message_chunk', text: narrative } });
  }
  return grouped;
}

function extractTagBody(text, tag) {
  const escapedTag = String(tag || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = '<' + escapedTag + '\\b[^>]*>([\\s\\S]*?)<\\/' + escapedTag + '>';
  const m = String(text || '').match(new RegExp(pattern, 'i'));
  return m ? m[1].trim() : '';
}

function extractTagBodies(text, tag) {
  const escapedTag = String(tag || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = '<' + escapedTag + '\\b([^>]*)>([\\s\\S]*?)<\\/' + escapedTag + '>';
  const re = new RegExp(pattern, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    out.push({ attrs: parseAttributesText(m[1] || ''), body: m[2].trim() });
  }
  return out;
}

function parseToolDetails(kind, text) {
  const raw = String(text || '');
  if (kind === 'TOOL_CALL') {
    const invoke = raw.match(/<invoke\b[^>]*\bname=["']([^"']+)["'][^>]*>/i);
    const tool = invoke ? invoke[1] : '';
    const params = extractTagBody(raw, 'parameter') || extractTagBody(raw, 'arguments') || extractTagBody(raw, 'args');
    const jsonish = params || (raw.match(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/i)?.[0] || '').replace(/<\/?invoke[^>]*>/gi, '').trim();
    if (tool || jsonish) return { title: tool ? `Tool: ${tool}` : 'Tool call', tool, args: jsonish };
  }
  if (kind === 'TOOL_RESULT') {
    const result = extractTagBody(raw, 'result') || raw.replace(/<\/?function_results[^>]*>/gi, '').trim();
    if (result) return { title: 'Tool result', tool: 'result', args: result };
  }
  return null;
}

function decodeXmlText(value) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return String(value || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  const div = document.createElement('div');
  div.innerHTML = String(value || '');
  return div.textContent || '';
}

function parseTagAttributes(text, tag) {
  const m = String(text || '').match(new RegExp(`<${tag}\\b([^>]*)>`, 'i'));
  const attrs = {};
  if (!m) return attrs;
  return parseAttributesText(m[1] || '');
}

function parseAttributesText(text) {
  const attrs = {};
  String(text || '').replace(/([A-Za-z0-9_-]+)=["']([^"']*)["']/g, (_, key, value) => {
    attrs[key] = decodeXmlText(value);
    return '';
  });
  return attrs;
}

function parseSubAgentDetails(kind, text) {
  const raw = String(text || '');
  if (kind !== 'SUB_AGENT_CALL' && kind !== 'SUB_AGENT_RESULT') return null;
  const tag = kind === 'SUB_AGENT_CALL' ? 'sub_agent_call' : 'sub_agent_result';
  const attrs = parseTagAttributes(raw, tag);
  return {
    kind,
    agent: attrs.agent || 'unknown',
    source: attrs.source || '',
    status: attrs.status || '',
    toolCallId: attrs.tool_call_id || '',
    summary: decodeXmlText(extractTagBody(raw, 'summary')),
    task: decodeXmlText(extractTagBody(raw, 'task')),
    allowedTools: decodeXmlText(extractTagBody(raw, 'allowed_tools')),
    agentFile: decodeXmlText(extractTagBody(raw, 'agent_file')),
    prompt: decodeXmlText(extractTagBody(raw, 'prompt')),
    transcript: decodeXmlText(extractTagBody(raw, 'transcript')),
    resultStatus: decodeXmlText(extractTagBody(raw, 'status')),
  };
}

function renderSubAgentRow(label, value, multiline = false) {
  if (!value) return '';
  const cls = multiline ? 'sub-agent-value sub-agent-transcript' : 'sub-agent-value';
  return `
    <div class="sub-agent-row">
      <div class="sub-agent-label">${escapeHtml(label)}</div>
      <pre class="${cls}">${escapeHtml(value)}</pre>
    </div>`;
}

function renderSubAgentDetailInto(container, seg) {
  const detail = parseSubAgentDetails(seg.kind, seg.text);
  if (!detail) return false;
  const isResult = seg.kind === 'SUB_AGENT_RESULT';
  const card = document.createElement('div');
  card.className = `sub-agent-card ${isResult ? 'sub-agent-result-card' : 'sub-agent-call-card'}`;
  const status = detail.resultStatus || detail.status || (isResult ? 'completed' : 'delegated');
  const title = isResult ? `子智能体 ${detail.agent} 对话` : `子智能体 ${detail.agent} 调用`;
  card.innerHTML = `
    <div class="sub-agent-card-head">
      <div>
        <div class="sub-agent-kicker">子智能体</div>
        <div class="sub-agent-title">${escapeHtml(title)}</div>
      </div>
      <span class="sub-agent-status">${escapeHtml(status)}</span>
    </div>
    <div class="sub-agent-meta">
      ${detail.source ? `<span>来源：${escapeHtml(detail.source)}</span>` : ''}
      ${detail.toolCallId ? `<span>调用：${escapeHtml(detail.toolCallId)}</span>` : ''}
      ${detail.allowedTools ? `<span>工具：${escapeHtml(detail.allowedTools)}</span>` : ''}
    </div>
    ${renderSubAgentRow('任务', detail.task)}
    ${renderSubAgentRow('Agent 文件', detail.agentFile)}
    ${renderSubAgentRow('实际 Prompt', detail.prompt, true)}
    ${renderSubAgentRow('对话 / 返回', detail.transcript, true)}
  `;
  container.appendChild(card);
  return true;
}

function parseTempSubAgentDetails(kind, text) {
  const raw = String(text || '');
  if (kind !== 'TEMP_SUB_AGENT_DIALOG') return null;
  const attrs = parseTagAttributes(raw, 'temp_sub_agent_dialog');
  const statuses = extractTagBodies(raw, 'status').map((item) => ({
    state: item.attrs.state || decodeXmlText(item.body),
    text: decodeXmlText(item.body),
  }));
  const messages = extractTagBodies(raw, 'message').map((item) => ({
    role: item.attrs.role || '',
    text: decodeXmlText(item.body),
  }));
  const openMessage = raw.match(/<message\b([^>]*)>(?![\s\S]*<\/message>)([\s\S]*)$/i);
  if (openMessage) {
    messages.push({
      role: parseAttributesText(openMessage[1] || '').role || '',
      text: decodeXmlText(openMessage[2] || ''),
    });
  }
  const latestStatus = statuses.length ? statuses[statuses.length - 1] : null;
  return {
    id: attrs.id || '',
    agent: attrs.agent || 'unknown',
    source: attrs.source || '',
    status: latestStatus?.state || attrs.status || 'running',
    statusText: latestStatus?.text || '',
    summary: decodeXmlText(extractTagBody(raw, 'summary')),
    task: decodeXmlText(extractTagBody(raw, 'task')),
    allowedTools: decodeXmlText(extractTagBody(raw, 'allowed_tools')),
    agentFile: decodeXmlText(extractTagBody(raw, 'agent_file')),
    messages,
  };
}

function tempSubAgentRoleLabel(role) {
  if (role === 'master') return '主智能体';
  if (role === 'agent') return '临时智能体';
  return role || '消息';
}

function tempSubAgentStatusLabel(status) {
  return {
    created: '已创建',
    running: '正在工作',
    waiting: '等待输出',
    stuck: '可能卡住',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }[status] || status || '运行中';
}

function renderTempSubAgentDetailInto(container, seg) {
  const detail = parseTempSubAgentDetails(seg.kind, seg.text);
  if (!detail) return false;
  updateTempSubAgentFloat(detail);
  const card = document.createElement('div');
  card.className = `temp-sub-agent-card status-${detail.status}`;
  const messages = detail.messages.length ? detail.messages : [{ role: 'agent', text: '等待临时智能体输出…' }];
  card.innerHTML = `
    <div class="temp-sub-agent-head">
      <div>
        <div class="temp-sub-agent-kicker">临时智能体</div>
        <div class="temp-sub-agent-title">${escapeHtml(detail.agent)}</div>
      </div>
      <span class="temp-sub-agent-status">${escapeHtml(tempSubAgentStatusLabel(detail.status))}</span>
    </div>
    <div class="temp-sub-agent-meta">
      ${detail.id ? `<span>ID：${escapeHtml(detail.id)}</span>` : ''}
      ${detail.source ? `<span>来源：${escapeHtml(detail.source)}</span>` : ''}
      ${detail.allowedTools ? `<span>工具：${escapeHtml(detail.allowedTools)}</span>` : ''}
      ${detail.agentFile ? `<span>文件：${escapeHtml(detail.agentFile)}</span>` : ''}
    </div>
    ${detail.statusText ? `<div class="temp-sub-agent-note">${escapeHtml(detail.statusText)}</div>` : ''}
    <div class="temp-sub-agent-dialog">
      ${messages.map((msg) => `
        <div class="temp-sub-agent-message ${escapeHtml(msg.role || 'other')}">
          <div class="temp-sub-agent-message-role">${escapeHtml(tempSubAgentRoleLabel(msg.role))}</div>
          <pre>${escapeHtml(msg.text || '')}</pre>
        </div>
      `).join('')}
    </div>
  `;
  container.appendChild(card);
  return true;
}

function updateTempSubAgentFloat(detail) {
  if (!tempAgentFloatEl || !detail) return;
  const detailId = String(detail.id || '');
  if (detailId && detailId !== tempAgentFloatDialogId) {
    tempAgentFloatDialogId = detailId;
    if (tempAgentFloatHiddenDialogId !== detailId) tempAgentFloatHiddenDialogId = null;
  }
  const hiddenByUser = !!detailId && tempAgentFloatHiddenDialogId === detailId;
  if (hiddenByUser) {
    tempAgentFloatEl.classList.add('hidden');
    tempAgentFloatEl.setAttribute('aria-hidden', 'true');
  } else {
    tempAgentFloatEl.classList.remove('hidden');
    tempAgentFloatEl.setAttribute('aria-hidden', 'false');
  }
  tempAgentFloatEl.classList.remove('status-running', 'status-waiting', 'status-stuck', 'status-completed', 'status-failed', 'status-cancelled');
  tempAgentFloatEl.classList.add(`status-${detail.status || 'running'}`);
  if (tempAgentFloatUserCollapsed === true && tempAgentFloatUserCollapsed !== false) setTempAgentFloatCollapsed(true, false);
  if (tempAgentFloatUserCollapsed === false) setTempAgentFloatCollapsed(false, false);
  if (tempAgentFloatTitleEl) tempAgentFloatTitleEl.textContent = detail.agent || 'unknown';
  if (tempAgentFloatStatusEl) tempAgentFloatStatusEl.textContent = tempSubAgentStatusLabel(detail.status);
  if (!tempAgentFloatDialogEl) return;
  const messages = detail.messages.length ? detail.messages.slice(-8) : [{ role: 'agent', text: '等待临时智能体输出…' }];
  tempAgentFloatDialogEl.innerHTML = messages.map((msg) => `
    <div class="temp-agent-float-message ${escapeHtml(msg.role || 'other')}">
      <span>${escapeHtml(tempSubAgentRoleLabel(msg.role))}</span>
      <pre>${escapeHtml(msg.text || '')}</pre>
    </div>
  `).join('');
  tempAgentFloatDialogEl.scrollTop = tempAgentFloatDialogEl.scrollHeight;
}

function setTempAgentFloatCollapsed(collapsed, userInitiated = false) {
  if (!tempAgentFloatEl) return;
  tempAgentFloatEl.classList.toggle('collapsed', !!collapsed);
  if (tempAgentFloatToggleBtn) {
    tempAgentFloatToggleBtn.setAttribute('aria-expanded', String(!collapsed));
    tempAgentFloatToggleBtn.title = collapsed ? '展开' : '收起';
    tempAgentFloatToggleBtn.setAttribute('aria-label', collapsed ? '展开临时智能体对话' : '收起临时智能体对话');
  }
  if (userInitiated) tempAgentFloatUserCollapsed = !!collapsed;
}

function closeTempSubAgentFloat() {
  if (!tempAgentFloatEl) return;
  tempAgentFloatHiddenDialogId = tempAgentFloatDialogId || tempAgentFloatHiddenDialogId;
  tempAgentFloatEl.classList.add('hidden');
  tempAgentFloatEl.setAttribute('aria-hidden', 'true');
}

function toggleTempSubAgentFloat() {
  if (!tempAgentFloatEl) return;
  if (tempAgentFloatEl.classList.contains('collapsed')) {
    setTempAgentFloatCollapsed(false, true);
  } else {
    setTempAgentFloatCollapsed(true, true);
  }
}

function syncTurnDisclosureState(turn, header) {
  if (!turn || !header) return;
  const collapsed = turn.classList.contains('collapsed');
  header.setAttribute('aria-expanded', String(!collapsed));
  header.title = collapsed ? '展开步骤详情' : '折叠步骤详情';
}

function setTurnUserExpanded(turn, expanded) {
  if (!turn) return;
  if (expanded) turn.dataset.userExpanded = '1';
  else delete turn.dataset.userExpanded;
}

function turnDisclosureKey(seg, index) {
  const kind = String(seg?.kind || '');
  const firstLine = String(seg?.text || '').trim().split(/\r?\n/)[0] || '';
  const stableText = firstLine.replace(/\s+/g, ' ').slice(0, 160);
  return `${Number(index || 0)}:${kind}:${stableText}`;
}

function rememberTurnDisclosure(options, key, expanded) {
  const store = options?.disclosureState;
  if (!store || !key) return;
  if (typeof store.set === 'function') {
    if (expanded) store.set(key, true);
    else if (typeof store.delete === 'function') store.delete(key);
    else store.set(key, false);
    return;
  }
  if (expanded) store[key] = true;
  else delete store[key];
}

function restoreTurnDisclosure(options, key) {
  const store = options?.disclosureState;
  if (!store || !key) return false;
  if (typeof store.get === 'function') return !!store.get(key);
  return !!store[key];
}

function bindTurnDisclosure(turn, header, onCollapseChange = null) {
  if (!turn || !header) return;
  syncTurnDisclosureState(turn, header);
  header.addEventListener('click', () => {
    turn.classList.toggle('collapsed');
    setTurnUserExpanded(turn, !turn.classList.contains('collapsed'));
    syncTurnDisclosureState(turn, header);
    if (typeof onCollapseChange === 'function') onCollapseChange(turn);
  });
}

function renderToolDetailInto(container, seg) {
  const detail = parseToolDetails(seg.kind, seg.text);
  if (!detail) return;
  const detailTurn = document.createElement('div');
  detailTurn.className = 'turn tool-detail-turn';
  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'turn-header tool-detail-header';
  header.innerHTML = `<span class="turn-caret">▼</span><span class="turn-tag">${escapeHtml(detail.title)}</span><span class="turn-summary">args</span>`;
  bindTurnDisclosure(detailTurn, header);
  const body = document.createElement('div');
  body.className = 'turn-body md tool-detail-body';
  const codeText = `Tool: ${detail.tool || detail.title.replace(/^Tool:\s*/, '') || 'tool'}\nargs:\n${detail.args || ''}`;
  body.innerHTML = `<pre class="tool-args-code"><code>${escapeHtml(codeText)}</code></pre>`;
  detailTurn.appendChild(header);
  detailTurn.appendChild(body);
  container.appendChild(detailTurn);
}

function renderTurnTreeInto(container, turn, options = {}) {
  const seg = turn.segment;
  const node = document.createElement('div');
  node.className = 'turn collapsed structured-turn turn-group';
  node.dataset.kind = seg.kind;
  node.dataset.buf = seg.text;
  const disclosureKey = turnDisclosureKey(seg, turn.index);
  if (seg.userExpanded || restoreTurnDisclosure(options, disclosureKey)) {
    node.classList.remove('collapsed');
    node.dataset.userExpanded = '1';
  }
  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'turn-header';
  const label = turnHeaderLabel(turn.index, turn.label);
  header.innerHTML = `${turnStatusDotHtml(seg.kind, seg.text, label, isTurnBusy(options, seg.kind, seg.text, label))}<span class="turn-caret">▼</span><span class="turn-tag">${escapeHtml(label)}</span>`;
  bindTurnDisclosure(node, header, () => {
    seg.collapsed = node.classList.contains('collapsed');
    seg.userExpanded = node.dataset.userExpanded === '1';
    rememberTurnDisclosure(options, disclosureKey, seg.userExpanded);
  });
  const body = document.createElement('div');
  body.className = 'turn-body md';
  const hasTempSubAgentDetail = renderTempSubAgentDetailInto(body, seg);
  const hasSubAgentDetail = hasTempSubAgentDetail || renderSubAgentDetailInto(body, seg);
  const hasToolDetail = Boolean(parseToolDetails(seg.kind, seg.text));
  if (!hasSubAgentDetail) renderToolDetailInto(body, seg);
  if (!hasToolDetail && !hasSubAgentDetail) {
    const rendered = document.createElement('div');
    rendered.className = 'turn-rendered-md';
    rendered.innerHTML = renderMarkdown(seg.text);
    body.appendChild(rendered);
  }
  node.appendChild(header);
  node.appendChild(body);
  container.appendChild(node);
}

/**
 * Extract <summary>...</summary> from text, render it as a faded italic hint,
 * and return the remaining text. If no summary tag found, returns text unchanged.
 */
/**
 * Strip leading <summary> and <think> tags from text.
 * Returns { summary, think, remaining } where summary/think are the extracted
 * content strings (or null), and remaining is the text to render as markdown.
 */
function stripLeadingMetaTags(text) {
  let remaining = text;
  let summary = null;
  let think = null;
  // Strip <summary>...</summary> at start
  const sumRe = /^<summary>([\s\S]*?)<\/summary>\s*/i;
  const sumM = remaining.match(sumRe);
  if (sumM) {
    summary = sumM[1].trim();
    remaining = remaining.slice(sumM[0].length);
  }
  // Strip <think>...</think> at start (or after summary)
  const thinkRe = /^<think>([\s\S]*?)<\/think>\s*/i;
  const thinkM = remaining.match(thinkRe);
  if (thinkM) {
    think = thinkM[1].trim();
    remaining = remaining.slice(thinkM[0].length);
  }
  return { summary, think, remaining };
}

function extractAndRenderSummary(container, text) {
  const { summary, think, remaining } = stripLeadingMetaTags(text);
  if (summary) {
    const hint = document.createElement('div');
    hint.className = 'summary-hint';
    hint.textContent = summary;
    container.appendChild(hint);
  }
  if (think) {
    const thinkEl = document.createElement('div');
    thinkEl.className = 'think-hint';
    thinkEl.textContent = think;
    container.appendChild(thinkEl);
  }
  return remaining;
}

function renderStructuredMarkdownInto(container, text, options = {}) {
  const segments = splitStructuredSegments(text);
  container.innerHTML = '';
  if (segments.length === 1 && !shouldFoldSegment(segments[0].kind, segments[0].text)) {
    const remaining = extractAndRenderSummary(container, text);
    if (remaining) container.insertAdjacentHTML('beforeend', renderMarkdown(remaining));
    return;
  }
  for (const item of groupIntoTurns(segments, options)) {
    if (item.type === 'plain') {
      const plain = document.createElement('div');
      plain.className = 'md';
      const remaining = extractAndRenderSummary(plain, item.segment.text);
      if (remaining) plain.insertAdjacentHTML('beforeend', renderMarkdown(remaining));
      container.appendChild(plain);
      continue;
    }
    renderTurnTreeInto(container, item, options);
  }
}

// ─── Copy button injection for code blocks and pre blocks ─────────────────
function injectCopyButtons(container) {
  if (!container) return;
  const blocks = container.querySelectorAll('pre');
  blocks.forEach(pre => {
    if (pre.querySelector('.copy-btn')) return; // already injected
    pre.style.position = 'relative';
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = '复制';
    btn.setAttribute('aria-label', '复制代码');
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code') || pre;
      navigator.clipboard.writeText(code.textContent).then(() => {
        btn.textContent = '已复制';
        btn.setAttribute('aria-label', '代码已复制');
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = '复制';
          btn.setAttribute('aria-label', '复制代码');
          btn.classList.remove('copied');
        }, 2000);
      }).catch(() => {
        btn.textContent = '复制失败';
        btn.setAttribute('aria-label', '复制代码失败');
        setTimeout(() => {
          btn.textContent = '复制';
          btn.setAttribute('aria-label', '复制代码');
        }, 2000);
      });
    });
    pre.appendChild(btn);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function goalPlanBlockRe() {
  return /<goal_plan\b[^>]*>([\s\S]*?)<\/goal_plan>/gi;
}

function normalizeGoalPlanStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'completed' || value === 'complete') return 'done';
  if (value === 'in_progress' || value === 'active') return 'running';
  if (value === 'todo') return 'pending';
  if (['pending', 'running', 'done', 'blocked', 'failed'].includes(value)) return value;
  return 'pending';
}

function parseGoalPlanFromText(text) {
  const raw = String(text || '');
  let latest = '';
  let match;
  const blockRe = goalPlanBlockRe();
  while ((match = blockRe.exec(raw)) !== null) latest = match[1] || '';
  if (!latest) return [];

  const items = [];
  const itemRe = /<item\b([^>]*)>([\s\S]*?)<\/item>/gi;
  while ((match = itemRe.exec(latest)) !== null) {
    const attrs = parseAttributesText(match[1] || '');
    const label = decodeXmlText(match[2] || '').trim();
    if (!label) continue;
    items.push({ text: label, status: normalizeGoalPlanStatus(attrs.status) });
  }
  return items;
}

function stripGoalPlanBlocks(text) {
  return String(text || '').replace(goalPlanBlockRe(), '').trim();
}

function updateSessionGoalPlanFromAssistantText(sess, text) {
  if (!sess) return false;
  const plan = parseGoalPlanFromText(text);
  if (!plan.length) return false;
  sess.goalPlan = plan;
  if (isActiveSession(sess)) renderGoalPlan();
  return true;
}

function goalPlanStatusLabel(status) {
  return {
    pending: '待执行',
    running: '执行中',
    done: '已完成',
    blocked: '卡住',
    failed: '失败',
  }[status] || '待执行';
}

function toggleGoalPlanCollapsed() {
  const sess = state.sessions.get(state.activeId);
  if (!sess) return;
  sess.goalPlanCollapsed = !sess.goalPlanCollapsed;
  renderGoalPlan();
}

function renderGoalPlan() {
  const sess = state.sessions.get(state.activeId);
  const plan = sess?.goalPlan || [];
  if (!goalPlanPanelEl || !goalPlanListEl || !plan.length) {
    if (goalPlanPanelEl) {
      goalPlanPanelEl.classList.add('hidden');
      goalPlanPanelEl.setAttribute('aria-hidden', 'true');
    }
    return;
  }

  goalPlanPanelEl.classList.remove('hidden');
  goalPlanPanelEl.setAttribute('aria-hidden', 'false');
  const doneCount = plan.filter((item) => item.status === 'done').length;
  if (goalPlanSummaryEl) goalPlanSummaryEl.textContent = `${doneCount}/${plan.length} 已完成`;
  goalPlanPanelEl.classList.toggle('collapsed', !!sess.goalPlanCollapsed);
  if (goalPlanToggleEl) {
    goalPlanToggleEl.setAttribute('aria-expanded', String(!sess.goalPlanCollapsed));
    goalPlanToggleEl.title = sess.goalPlanCollapsed ? '展开目标任务' : '收起目标任务';
    goalPlanToggleEl.setAttribute('aria-label', goalPlanToggleEl.title);
  }
  goalPlanListEl.innerHTML = plan.map((item) => {
    const status = normalizeGoalPlanStatus(item.status);
    const checked = status === 'done';
    const itemClass = status === 'done' ? 'goal-plan-item done' : `goal-plan-item ${status}`;
    return `
      <li class="${itemClass}">
        <span class="goal-plan-check" aria-hidden="true">${checked ? '✓' : ''}</span>
        <span class="goal-plan-text">${escapeHtml(item.text)}</span>
        <span class="goal-plan-status">${escapeHtml(goalPlanStatusLabel(status))}</span>
      </li>`;
  }).join('');
}

function blackboardCleanSummary(text, fallback = '事实', limit = 100) {
  const raw = stripGoalPlanBlocks(String(text || ''))
    .replace(/<summary>\s*([\s\S]*?)\s*<\/summary>/gi, '$1')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|\s)[*_]{1,3}([^*_]+)[*_]{1,3}(\s|$)/g, '$1$2$3')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const value = raw || fallback;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function blackboardCleanFinalAnswerText(text, fallback = 'Agent 事实') {
  const raw = stripGoalPlanBlocks(String(text || ''));
  if (!raw.trim()) return fallback;
  const parts = raw.split(/\**LLM Running \(Turn \d+\) \.\.\.\**/gi);
  const candidates = parts.length > 1 ? parts.slice(1) : [raw];
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const cleaned = blackboardCleanFinalAnswerCandidate(candidates[index]);
    if (cleaned) return cleaned;
  }
  return blackboardCleanFinalAnswerCandidate(raw) || fallback;
}

function blackboardCleanFinalAnswerCandidate(text) {
  const withoutBlocks = String(text || '')
    .replace(/<summary>[\s\S]*?<\/summary>/gi, ' ')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<function_calls\b[^>]*>[\s\S]*?<\/function_calls>/gi, ' ')
    .replace(/<function_results\b[^>]*>[\s\S]*?<\/function_results>/gi, ' ')
    .replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, ' ')
    .replace(/<result\b[^>]*>[\s\S]*?<\/result>/gi, ' ')
    .replace(/`{3,}[\s\S]*?`{3,}/g, ' ')
    .replace(/`{3,}[\s\S]*$/g, ' ');
  const lines = withoutBlocks.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (/^\**LLM Running \(Turn \d+\) \.\.\.\**$/i.test(trimmed)) return false;
    if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(trimmed)) return false;
    if (/^(🛠️\s*)?Tool\s*:/i.test(trimmed)) return false;
    if (/^(📥\s*)?args\s*:/i.test(trimmed)) return false;
    if (/^\[(Action|Status|Stdout|Stderr|Info|omitted)\b/i.test(trimmed)) return false;
    if (/^`{3,}/.test(trimmed)) return false;
    return true;
  });
  return lines.join('\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|\s)[*_]{1,3}([^*_]+)[*_]{1,3}(\s|$)/g, '$1$2$3')
    .replace(/[*_`]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function blackboardCleanFinalAnswerSummary(text, fallback = 'Agent 事实', limit = 220) {
  const clean = blackboardCleanFinalAnswerText(text, fallback).replace(/\s+/g, ' ').trim() || fallback;
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

const BLACKBOARD_DETAIL_LIMIT = 5000;
const BLACKBOARD_DETAIL_SOURCE_LIMIT = 12000;
const BLACKBOARD_FINAL_DETAIL_LIMIT = 16000;
const BLACKBOARD_MAX_GRAPH_MESSAGES = 40;
const BLACKBOARD_MAX_VISIBLE_FACTS = 18;
const BLACKBOARD_MAX_VISIBLE_INTENTS = 14;
const BLACKBOARD_MAX_VISIBLE_HINTS = 3;
const BLACKBOARD_NODE_BODY_LIMIT = 52;
const BLACKBOARD_MAX_TIMELINE_EVENTS = 60;

function blackboardCleanDetail(text, fallback = '暂无详情', options = {}) {
  const detailLimit = Number(options.limit || BLACKBOARD_DETAIL_LIMIT);
  const sourceLimit = Number(options.sourceLimit || Math.max(BLACKBOARD_DETAIL_SOURCE_LIMIT, detailLimit + 1000));
  const source = String(text || '');
  const sourceTooLong = source.length > sourceLimit;
  const boundedSource = sourceTooLong ? source.slice(0, sourceLimit) : source;
  const raw = stripGoalPlanBlocks(boundedSource)
    .replace(/<summary>\s*([\s\S]*?)\s*<\/summary>/gi, '$1')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<function_calls\b[^>]*>/gi, '')
    .replace(/<\/function_calls>/gi, '')
    .replace(/<function_results\b[^>]*>/gi, '')
    .replace(/<\/function_results>/gi, '')
    .replace(/<invoke\b[^>]*\bname=["']([^"']+)["'][^>]*>/gi, 'Tool: $1\n')
    .replace(/<\/invoke>/gi, '')
    .replace(/<parameter\b[^>]*\bname=["']([^"']+)["'][^>]*>/gi, '$1: ')
    .replace(/<\/parameter>/gi, '')
    .replace(/<result\b[^>]*>/gi, '')
    .replace(/<\/result>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  const value = raw || fallback;
  if (value.length <= detailLimit && !sourceTooLong) return value;
  const reason = sourceTooLong ? '原始内容过长，已截断以避免界面卡顿' : '内容过长，已截断以避免界面卡顿';
  return `${value.slice(0, detailLimit)}\n\n[${reason}]`;
}

function blackboardRawDetail(text, fallback = '暂无详情') {
  const raw = String(text || '').trim();
  return raw || fallback;
}

function blackboardToolName(text) {
  const detail = parseToolDetails('TOOL_CALL', text);
  return detail?.tool || '';
}

function blackboardKindMeta(kind, text = '') {
  const normalized = String(kind || '').trim();
  if (normalized === 'permission') return { type: 'permission', label: '权限确认' };
  if (normalized === 'error') return { type: 'error', label: '错误事实' };
  if (normalized === 'system') return { type: 'system', label: '系统事实' };
  if (normalized === 'TOOL_CALL' || normalized === 'Tool') return { type: 'tool', label: executionStageLabel(normalized, text) };
  if (normalized === 'TOOL_RESULT' || normalized === 'Result') return { type: 'tool', label: '工具结果' };
  if (normalized === 'SUB_AGENT_CALL' || normalized === 'TEMP_SUB_AGENT_DIALOG') return { type: 'agent', label: '子 Agent' };
  if (normalized === 'SUB_AGENT_RESULT') return { type: 'agent', label: '子 Agent 结果' };
  if (normalized === 'LLM_RUNNING' || normalized === 'agent_thought_chunk' || normalized === 'thinking') return { type: 'reason', label: 'Reason' };
  return { type: 'fact', label: 'Agent 事实' };
}

function blackboardAddIntent(graph, fromId, description, status, options = {}) {
  const intentId = options.id || `i${String(options.index || graph.intents.length + 1).padStart(3, '0')}`;
  graph.intents.push({
    id: intentId,
    from: [fromId || 'origin'],
    to: options.to || null,
    description: blackboardCleanSummary(description, 'Agent intent', 180),
    detail: blackboardRawDetail(options.detail || description, description || 'Agent intent'),
    creator: options.creator || 'secheur.agent',
    worker: options.worker || 'SecHeur Agent',
    status: status || 'concluded',
    sourceMessageId: options.sourceMessageId || null,
  });
  return intentId;
}

function blackboardAddFact(graph, kind, description, options = {}) {
  const factId = options.id || `f${String(options.index || graph.facts.length + 1).padStart(3, '0')}`;
  const summary = options.finalAnswer
    ? blackboardCleanFinalAnswerSummary(description, 'Agent 事实', options.limit || 220)
    : blackboardCleanSummary(description, 'Agent 事实', options.limit || 220);
  graph.facts.push({
    id: factId,
    kind: kind || 'fact',
    description: summary,
    detail: blackboardRawDetail(options.detail || description, description || 'Agent 事实'),
    sourceMessageId: options.sourceMessageId || null,
  });
  return factId;
}

function blackboardIngestAssistantSegment(graph, segment, context) {
  const kind = String(segment?.kind || 'agent_message_chunk');
  const text = String(segment?.text || '').trim();
  if (!text) return context.lastFactId;
  const meta = blackboardKindMeta(kind, text);
  const status = context.status || 'concluded';
  const sourceMessageId = context.sourceMessageId || null;
  if (kind === 'TOOL_CALL') {
    blackboardAddIntent(graph, context.lastFactId, executionStageLabel(kind, text), status === 'failed' ? 'failed' : status, {
      index: context.nextIntentIndex(),
      detail: text,
      worker: blackboardToolName(text) || 'tool',
      sourceMessageId,
    });
    return context.lastFactId;
  }
  if (kind === 'LLM_RUNNING' || kind === 'agent_thought_chunk' || kind === 'thinking') {
    blackboardAddIntent(graph, context.lastFactId, executionStageLabel(kind, text), status === 'failed' ? 'failed' : 'running', {
      index: context.nextIntentIndex(),
      detail: text,
      worker: 'SecHeur Agent',
      sourceMessageId,
    });
    return context.lastFactId;
  }
  const factId = blackboardAddFact(graph, meta.type, text, {
    index: context.nextFactIndex(),
    detail: text,
    finalAnswer: meta.type === 'fact',
    sourceMessageId,
  });
  blackboardAddIntent(graph, context.lastFactId, meta.label, status, {
    index: context.nextIntentIndex(),
    to: factId,
    detail: text,
    worker: kind === 'TOOL_RESULT' ? 'tool result' : 'SecHeur Agent',
    sourceMessageId,
  });
  return factId;
}

function blackboardRecentMessagesForGraph(messages, firstUser = null) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length <= BLACKBOARD_MAX_GRAPH_MESSAGES) return list;
  const recent = list.slice(-BLACKBOARD_MAX_GRAPH_MESSAGES);
  if (!firstUser) return recent;
  const hasFirstUser = recent.some((msg) => msg === firstUser || (firstUser.id && msg?.id === firstUser.id));
  return hasFirstUser ? recent : [firstUser, ...recent];
}

function blackboardGraphWindowSequenceOffset(messages, graphMessages, firstUser = null) {
  const list = Array.isArray(messages) ? messages : [];
  const retained = Array.isArray(graphMessages) ? graphMessages : [];
  const firstWindowMessage = retained.find((msg) => !(firstUser && (msg === firstUser || (firstUser.id && msg?.id === firstUser.id))));
  const firstWindowIndex = firstWindowMessage ? list.indexOf(firstWindowMessage) : -1;
  if (firstWindowIndex <= 0) return { fact: 0, intent: 0 };
  let fact = 0;
  let intent = 0;
  for (const msg of list.slice(0, firstWindowIndex)) {
    if (firstUser && (msg === firstUser || (firstUser.id && msg?.id === firstUser.id))) continue;
    if (['assistant', 'error', 'system'].includes(msg?.role)) {
      fact += 1;
      intent += 1;
    } else if (msg?.role === 'permission') {
      intent += 1;
    }
  }
  return { fact, intent };
}

function blackboardGraphFromSession(sess) {
  if (!sess) return emptyBlackboardGraph();
  const runtime = getSessionRuntime(sess);
  const draft = runtime?.assistantDraft;
  const hasLiveDraft = (draft && !draft.finalized) || runtime?.busy;
  if (!hasLiveDraft && sess.blackboardGraph && Array.isArray(sess.blackboardGraph.facts)) return sess.blackboardGraph;
  const messages = [...(sess.messages || [])];
  if (draft && !draft.finalized) {
    messages.push({ id: 0, role: 'assistant', content: draft.text || runtime.currentStageText || '正在处理请求', partial: true, ts: Date.now() / 1000 });
  } else if (runtime?.busy) {
    messages.push({ id: 0, role: 'assistant', content: runtime.currentStageText || '正在处理请求', partial: true, ts: Date.now() / 1000 });
  }
  const firstUser = messages.find((msg) => msg.role === 'user');
  const origin = blackboardCleanSummary(firstUser?.content, '等待用户目标', 160);
  const graph = {
    project: {
      id: sess.bridgeSessionId || sess.id,
      title: sess.title || 'New chat',
      status: runtime?.busy ? 'running' : 'idle',
      origin,
      goal: firstUser ? `完成用户目标：${origin}` : '等待明确目标',
      reason: runtime?.busy ? { worker: 'SecHeur Agent', trigger: 'active_turn' } : null,
    },
    facts: [
      { id: 'origin', kind: 'origin', description: origin, detail: blackboardRawDetail(firstUser?.content, origin), sourceMessageId: firstUser?.id || null },
      { id: 'goal', kind: 'goal', description: firstUser ? `完成用户目标：${origin}` : '等待明确目标', detail: firstUser ? `完成用户目标：${blackboardRawDetail(firstUser.content, origin)}` : '等待明确目标', sourceMessageId: firstUser?.id || null },
    ],
    intents: [],
    hints: [],
    summary: {},
  };
  let lastFactId = 'origin';
  const graphMessages = blackboardRecentMessagesForGraph(messages, firstUser);
  const sequenceOffset = blackboardGraphWindowSequenceOffset(messages, graphMessages, firstUser);
  let factIndex = sequenceOffset.fact + 1;
  let intentIndex = sequenceOffset.intent + 1;
  for (const msg of graphMessages) {
    if (msg.role === 'user') {
      if (firstUser && (msg === firstUser || (firstUser.id && msg.id === firstUser.id))) continue;
      graph.hints.push({
        id: `h${String(graph.hints.length + 1).padStart(3, '0')}`,
        content: blackboardCleanSummary(msg.content, '用户补充', 160),
        detail: blackboardRawDetail(msg.content, '用户补充'),
        creator: msg.source || 'user',
        sourceMessageId: msg.id || null,
      });
    } else if (msg.role === 'permission') {
      const status = msg.status === 'resolved' ? 'concluded' : 'running';
      graph.intents.push({
        id: `i${String(intentIndex++).padStart(3, '0')}`,
        from: [lastFactId],
        to: null,
        description: blackboardCleanSummary(msg.title || msg.content, '权限确认', 150),
        detail: blackboardRawDetail(msg.content || msg.title, msg.title || '权限确认'),
        creator: 'desktop.permission',
        worker: msg.tool_name || msg.toolName || 'permission',
        status,
        sourceMessageId: msg.id || null,
      });
    } else if (['assistant', 'error', 'system'].includes(msg.role)) {
      const status = msg.partial ? 'running' : msg.role === 'error' ? 'failed' : 'concluded';
      if (status === 'running') {
        graph.intents.push({
          id: `i${String(intentIndex++).padStart(3, '0')}`,
          from: [lastFactId],
          to: null,
          description: blackboardCleanSummary(msg.content, 'Agent 正在探索', 180),
          detail: blackboardRawDetail(msg.content, 'Agent 正在探索'),
          creator: 'secheur.agent',
          worker: 'SecHeur Agent',
          status,
          sourceMessageId: msg.id || null,
        });
        continue;
      }
      const segments = msg.role === 'assistant' ? splitStructuredSegments(msg.content) : [{ kind: msg.role, text: msg.content }];
      const context = {
        lastFactId,
        status,
        sourceMessageId: msg.id || null,
        nextFactIndex: () => factIndex++,
        nextIntentIndex: () => intentIndex++,
      };
      for (const segment of segments) {
        context.lastFactId = blackboardIngestAssistantSegment(graph, segment, context);
      }
      lastFactId = context.lastFactId;
    }
  }
  if (messages[messages.length - 1]?.partial && !graph.intents.some((intent) => intent.status === 'running')) {
    graph.intents.push({
      id: `i${String(intentIndex++).padStart(3, '0')}`,
      from: [lastFactId],
      to: null,
      description: blackboardCleanSummary(messages[messages.length - 1].content, 'Agent 正在探索', 180),
      detail: blackboardRawDetail(messages[messages.length - 1].content, 'Agent 正在探索'),
      creator: 'secheur.agent',
      worker: 'SecHeur Agent',
      status: 'running',
      sourceMessageId: messages[messages.length - 1].id || null,
    });
  }
  graph.summary = {
    factCount: graph.facts.length,
    intentCount: graph.intents.length,
    hintCount: graph.hints.length,
    runningIntentCount: graph.intents.filter((intent) => intent.status === 'running').length,
    openIntentCount: graph.intents.filter((intent) => !intent.to).length,
  };
  return graph;
}

function emptyBlackboardGraph() {
  return {
    project: { id: '', title: '', status: 'idle', origin: '等待用户目标', goal: '等待明确目标', reason: null },
    facts: [],
    intents: [],
    hints: [],
    summary: { factCount: 0, intentCount: 0, hintCount: 0, runningIntentCount: 0, openIntentCount: 0 },
  };
}

function blackboardGraphIsRunning(graph) {
  const status = String(graph?.project?.status || '').toLowerCase();
  if (status === 'running' || status === 'queue' || status === 'working') return true;
  const summary = graph?.summary || {};
  if (Number(summary.runningIntentCount || 0) > 0) return true;
  const intents = Array.isArray(graph?.intents) ? graph.intents : [];
  return intents.some((intent) => {
    const intentStatus = String(intent?.status || '').toLowerCase();
    return intentStatus === 'running' || intentStatus === 'working' || intentStatus === 'claimed';
  });
}

function blackboardIntentStatusLabel(status) {
  return {
    concluded: '已结论',
    running: '进行中',
    failed: '失败',
    unclaimed: '未认领',
  }[status] || '已结论';
}

function blackboardNodeKindLabel(kind) {
  return {
    origin: 'Origin',
    goal: 'Goal',
    fact: 'Fact',
    tool: 'Fact',
    agent: 'Fact',
    reason: 'Fact',
    error: 'Error',
    system: 'System',
    permission: 'Intent',
    intent: 'Intent',
    hint: 'Hint',
    open: '?',
  }[kind] || 'Fact';
}

function blackboardHeuristicLearningEnabled() {
  return typeof isHeuristicLearningEnabled === 'function' && isHeuristicLearningEnabled();
}

function blackboardHeuristicNodeKind(kind, status = '') {
  if (!blackboardHeuristicLearningEnabled()) return kind;
  const normalized = String(kind || 'fact');
  const normalizedStatus = String(status || '');
  if (normalized === 'origin' || normalized === 'goal' || normalized === 'hint' || normalized === 'open') return normalized;
  if (normalized === 'intent') return 'intent';
  if (normalizedStatus === 'failed' || normalized === 'error') return 'feedback';
  if (normalized === 'tool' || normalized === 'system' || normalized === 'permission') return 'state';
  if (normalized === 'reason') return 'heuristic';
  return normalized;
}

function blackboardNodeDisplayKind(kind, status = '') {
  if (!blackboardHeuristicLearningEnabled()) return blackboardNodeKindLabel(kind);
  const heuristicKind = blackboardHeuristicNodeKind(kind, status);
  return {
    origin: 'Origin',
    goal: 'Goal',
    fact: 'Fact',
    tool: 'State',
    agent: 'Fact',
    reason: 'Heuristic',
    error: 'Feedback',
    system: 'State',
    permission: 'State',
    state: 'State',
    feedback: 'Feedback',
    heuristic: 'Heuristic',
    intent: 'Intent',
    hint: 'Hint',
    open: '?',
  }[heuristicKind] || 'Fact';
}

function blackboardCompactNodeBody(text, fallback = '详情', limit = BLACKBOARD_NODE_BODY_LIMIT) {
  return blackboardCleanSummary(text, fallback, limit);
}

function blackboardFactTitle(fact) {
  const kind = String(fact?.kind || 'fact');
  if (kind === 'origin') return 'Origin';
  if (kind === 'goal') return 'Goal';
  return blackboardNodeDisplayKind(kind, '');
}

function blackboardNodeClass(node) {
  const parts = ['blackboard-graph-node', node.kind || 'fact'];
  const displayKind = blackboardHeuristicNodeKind(node.kind, node.status);
  if (displayKind && displayKind !== node.kind) parts.push(displayKind);
  if (node.status) parts.push(node.status);
  return parts.join(' ');
}

function blackboardNodeStyle(node) {
  return `left:${Math.round(node.x)}px;top:${Math.round(node.y)}px;width:${Math.round(node.width)}px;height:${Math.round(node.height)}px;`;
}

function blackboardAddLayoutNode(nodes, seen, node) {
  if (!node?.id || seen.has(node.id)) return;
  seen.add(node.id);
  nodes.push(node);
}

function blackboardBuildFacts(graph) {
  const facts = Array.isArray(graph?.facts) ? graph.facts : [];
  if (facts.length) return facts;
  const project = graph?.project || {};
  return [
    { id: 'origin', kind: 'origin', description: project.origin || '等待用户目标' },
    { id: 'goal', kind: 'goal', description: project.goal || '等待明确目标' },
  ];
}

function blackboardVisibleFactsForLayout(graph, intents) {
  const facts = blackboardBuildFacts(graph);
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const anchorIds = [];
  const relationIds = [];
  const addAnchor = (id) => {
    if (id && byId.has(id) && !anchorIds.includes(id)) anchorIds.push(id);
  };
  const addRelation = (id) => {
    if (!id || !byId.has(id) || anchorIds.includes(id) || relationIds.includes(id)) return;
    relationIds.push(id);
  };
  addAnchor('origin');
  addAnchor('goal');
  for (const intent of intents || []) {
    const fromIds = Array.isArray(intent?.from) && intent.from.length ? intent.from : ['origin'];
    fromIds.forEach(addRelation);
    if (intent?.to) addRelation(intent.to);
  }
  facts
    .filter((fact) => fact?.id && !anchorIds.includes(fact.id))
    .slice(-BLACKBOARD_MAX_VISIBLE_FACTS)
    .forEach((fact) => addRelation(fact.id));
  const visibleRelationIds = relationIds.slice(-BLACKBOARD_MAX_VISIBLE_FACTS);
  return [...anchorIds, ...visibleRelationIds].map((id) => byId.get(id)).filter(Boolean);
}

function layoutBlackboardGraph(graph) {
  const intents = (Array.isArray(graph?.intents) ? graph.intents : []).slice(-BLACKBOARD_MAX_VISIBLE_INTENTS);
  const hints = (Array.isArray(graph?.hints) ? graph.hints : []).slice(-BLACKBOARD_MAX_VISIBLE_HINTS);
  const facts = blackboardVisibleFactsForLayout(graph, intents);
  const levels = new Map();
  const factsById = new Map(facts.map((fact) => [fact.id, fact]));
  const nodes = [];
  const edges = [];
  const seen = new Set();
  const setLevel = (id, level) => {
    if (!id) return;
    const current = levels.get(id);
    if (current === undefined || level > current) levels.set(id, level);
  };
  const getLevel = (id) => levels.get(id) ?? 0;

  setLevel('origin', 0);
  setLevel('goal', 0);
  for (const intent of intents) {
    const fromIds = Array.isArray(intent.from) && intent.from.length ? intent.from : ['origin'];
    const sourceLevel = Math.max(0, ...fromIds.map((id) => getLevel(id)));
    const intentLevel = sourceLevel + 1;
    setLevel(intent.id, intentLevel);
    if (intent.to) setLevel(intent.to, intentLevel + 1);
    else setLevel(`open-${intent.id}`, intentLevel + 1);
  }
  hints.forEach((hint, idx) => setLevel(hint.id || `hint-${idx + 1}`, 1));

  for (const fact of facts) {
    const kind = fact.kind || 'fact';
    const compact = kind === 'origin' || kind === 'goal';
    blackboardAddLayoutNode(nodes, seen, {
      id: fact.id,
      kind,
      title: blackboardFactTitle(fact),
      body: blackboardCompactNodeBody(fact.description, blackboardNodeDisplayKind(kind), compact ? 48 : BLACKBOARD_NODE_BODY_LIMIT),
      detail: blackboardRawDetail(fact.detail || fact.description, fact.description || blackboardNodeKindLabel(kind)),
      status: '',
      level: getLevel(fact.id),
      width: compact ? 104 : 186,
      height: compact ? 62 : 84,
    });
  }

  for (const intent of intents) {
    const fromIds = Array.isArray(intent.from) && intent.from.length ? intent.from : ['origin'];
    const status = intent.status || 'concluded';
    blackboardAddLayoutNode(nodes, seen, {
      id: intent.id,
      kind: 'intent',
      title: `Intent ${intent.id || ''}`.trim(),
      body: blackboardCompactNodeBody(intent.description, 'Agent intent'),
      detail: blackboardRawDetail(intent.detail || intent.description, intent.description || 'Agent intent'),
      status,
      level: getLevel(intent.id),
      width: 186,
      height: 84,
    });
    for (const fromId of fromIds) {
      edges.push({
        id: `${fromId}-${intent.id}`,
        from: fromId,
        to: intent.id,
        kind: status === 'failed' ? 'failed' : 'concluded',
        label: intent.worker || '',
      });
    }
    if (intent.to) {
      edges.push({
        id: `${intent.id}-${intent.to}`,
        from: intent.id,
        to: intent.to,
        kind: status === 'failed' ? 'failed' : 'concluded',
        label: blackboardIntentStatusLabel(status),
      });
    } else {
      const openId = `open-${intent.id}`;
      blackboardAddLayoutNode(nodes, seen, {
        id: openId,
        kind: 'open',
        title: '?',
        body: blackboardIntentStatusLabel(status),
        detail: blackboardRawDetail(intent.detail || intent.description, blackboardIntentStatusLabel(status)),
        status,
        level: getLevel(openId),
        width: 44,
        height: 44,
      });
      edges.push({
        id: `${intent.id}-${openId}`,
        from: intent.id,
        to: openId,
        kind: 'open',
        label: 'open',
      });
      if (factsById.has('goal')) {
        edges.push({
          id: `${openId}-goal`,
          from: openId,
          to: 'goal',
          kind: 'open',
          label: 'next',
        });
      }
    }
  }

  for (const [idx, hint] of hints.entries()) {
    const id = hint.id || `hint-${idx + 1}`;
    blackboardAddLayoutNode(nodes, seen, {
      id,
      kind: 'hint',
      title: 'Hint',
      body: blackboardCompactNodeBody(hint.content, '用户提示'),
      detail: blackboardRawDetail(hint.detail || hint.content, hint.content || '用户提示'),
      status: '',
      level: getLevel(id),
      width: 168,
      height: 70,
    });
    edges.push({ id: `origin-${id}`, from: 'origin', to: id, kind: 'open', label: 'hint' });
  }

  const byLevel = new Map();
  for (const node of nodes) {
    const level = Math.max(0, Number(node.level || 0));
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(node);
  }
  for (const group of byLevel.values()) {
    group.sort((a, b) => {
      const order = { origin: 0, fact: 1, tool: 1, agent: 1, reason: 1, intent: 2, open: 3, hint: 4, goal: 9 };
      return (order[a.kind] ?? 5) - (order[b.kind] ?? 5) || String(a.id).localeCompare(String(b.id));
    });
  }

  const levelGap = 310;
  const rowGap = 140;
  let maxRight = 0;
  let maxBottom = 0;
  for (const [level, group] of byLevel.entries()) {
    const baseX = level === 0 ? 36 : 240 + (level - 1) * levelGap;
    const baseY = level === 0 ? 76 : Math.max(40, 220 - ((group.length - 1) * rowGap) / 2);
    group.forEach((node, idx) => {
      node.x = baseX;
      if (node.kind === 'origin') node.y = 74;
      else if (node.kind === 'goal') node.y = 250;
      else node.y = baseY + idx * rowGap + ((idx % 2) * 12);
      maxRight = Math.max(maxRight, node.x + node.width);
      maxBottom = Math.max(maxBottom, node.y + node.height);
    });
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const drawableEdges = edges
    .map((edge) => ({ ...edge, fromNode: nodeById.get(edge.from), toNode: nodeById.get(edge.to) }))
    .filter((edge) => edge.fromNode && edge.toNode);
  return {
    nodes,
    edges: drawableEdges,
    width: Math.max(920, maxRight + 96),
    height: Math.max(420, maxBottom + 68),
  };
}

function blackboardEdgePath(edge) {
  const from = edge.fromNode;
  const to = edge.toNode;
  const startX = from.x + from.width;
  const startY = from.y + from.height / 2;
  const endX = to.x;
  const endY = to.y + to.height / 2;
  const dx = Math.max(70, Math.abs(endX - startX) * 0.46);
  const direction = endX >= startX ? 1 : -1;
  const c1x = startX + dx * direction;
  const c2x = endX - dx * direction;
  return `M ${startX} ${startY} C ${c1x} ${startY}, ${c2x} ${endY}, ${endX} ${endY}`;
}

function blackboardRenderEdge(edge) {
  const marker = edge.kind === 'open'
    ? 'url(#blackboard-arrow-open)'
    : edge.kind === 'failed'
      ? 'url(#blackboard-arrow-failed)'
      : 'url(#blackboard-arrow-concluded)';
  return `<path class="blackboard-graph-edge ${escapeHtml(edge.kind)}" d="${blackboardEdgePath(edge)}" marker-end="${marker}"></path>`;
}

function blackboardRenderEdgeLabel(edge) {
  if (!edge.label) return '';
  const from = edge.fromNode;
  const to = edge.toNode;
  const x = (from.x + from.width + to.x) / 2;
  const y = (from.y + from.height / 2 + to.y + to.height / 2) / 2 - 12;
  const label = blackboardCleanSummary(edge.label, '', 24);
  const width = Math.max(34, Math.min(132, label.length * 7 + 18));
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);
  return `<g class="blackboard-graph-edge-label" transform="translate(${roundedX} ${roundedY})">
    <rect class="blackboard-graph-edge-label-bg" x="${Math.round(-width / 2)}" y="-9" width="${Math.round(width)}" height="18" rx="9"></rect>
    <text class="blackboard-graph-edge-label-text" x="0" y="0">${escapeHtml(label)}</text>
  </g>`;
}

function blackboardEventTimestamp(record, fallbackOrder = 0) {
  const raw = record?.created_at || record?.createdAt || record?.ts || record?.timestamp || '';
  if (raw) return String(raw);
  const order = String(fallbackOrder).padStart(4, '0');
  return `local-${order}`;
}

function blackboardCompareTimelineTimestamp(a, b) {
  const left = a?.timestamp;
  const right = b?.timestamp;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  const leftDate = Date.parse(left);
  const rightDate = Date.parse(right);
  if (Number.isFinite(leftDate) && Number.isFinite(rightDate) && leftDate !== rightDate) {
    return leftDate - rightDate;
  }
  return String(left || '').localeCompare(String(right || ''));
}

function blackboardTimelineLabel(type) {
  return {
    project_created: 'Project',
    hint_added: 'Hint',
    intent_declared: 'Intent',
    intent_concluded: 'Fact',
    project_completed: 'Done',
  }[type] || 'Event';
}

function blackboardTimelineTitle(event) {
  return blackboardCleanSummary(event?.title, blackboardTimelineLabel(event?.type), 84);
}

function blackboardTimelineEvents(graph) {
  if (!graph) return [];
  const events = [];
  let order = 0;
  const project = graph.project || {};
  const facts = Array.isArray(graph.facts) ? graph.facts : [];
  const intents = Array.isArray(graph.intents) ? graph.intents : [];
  const hints = Array.isArray(graph.hints) ? graph.hints : [];
  const factById = new Map(facts.map((fact) => [fact.id, fact]));
  const origin = factById.get('origin');
  const goal = factById.get('goal');
  events.push({
    id: `project-created-${project.id || 'local'}`,
    type: 'project_created',
    timestamp: blackboardEventTimestamp(project, order),
    actor: 'system',
    title: project.title || project.origin || origin?.description || '开始对话',
    meta: [origin?.description, goal?.description ? `goal: ${goal.description}` : ''].filter(Boolean),
    targetType: 'fact',
    targetId: origin?.id || 'origin',
    intentId: null,
    producedFactId: null,
    sourceFactIds: [],
    order: order++,
  });
  for (const hint of hints) {
    const id = hint.id || `hint-${order}`;
    events.push({
      id: `hint-${id}`,
      type: 'hint_added',
      timestamp: blackboardEventTimestamp(hint, order),
      actor: hint.creator || 'user',
      title: hint.content || hint.detail || '用户提示',
      meta: [],
      targetType: 'hint',
      targetId: id,
      intentId: null,
      producedFactId: null,
      sourceFactIds: [],
      order: order++,
    });
  }
  for (const intent of intents) {
    const fromIds = Array.isArray(intent.from) && intent.from.length ? intent.from : ['origin'];
    events.push({
      id: `intent-declared-${intent.id}`,
      type: 'intent_declared',
      timestamp: blackboardEventTimestamp(intent, order),
      actor: intent.creator || 'secheur.agent',
      title: intent.description || 'Agent intent',
      meta: [intent.id, `from ${fromIds.join(', ')}`].filter(Boolean),
      targetType: 'intent',
      targetId: intent.id,
      intentId: intent.id,
      producedFactId: null,
      sourceFactIds: [...fromIds],
      order: order++,
    });
    if (!intent.to) continue;
    const fact = factById.get(intent.to);
    const completed = intent.to === 'goal';
    events.push({
      id: `${completed ? 'project-completed' : 'intent-concluded'}-${intent.id}`,
      type: completed ? 'project_completed' : 'intent_concluded',
      timestamp: blackboardEventTimestamp({ created_at: intent.concluded_at || intent.concludedAt || intent.updated_at || intent.created_at || intent.ts }, order),
      actor: intent.worker || intent.creator || 'secheur.agent',
      title: fact?.description || intent.description || '产生事实',
      meta: [intent.id, `produced ${intent.to}`, `from ${fromIds.join(', ')}`].filter(Boolean),
      targetType: 'fact',
      targetId: intent.to,
      intentId: intent.id,
      producedFactId: intent.to,
      sourceFactIds: [...fromIds],
      order: order++,
    });
  }
  const chronological = [...events].sort((a, b) => blackboardCompareTimelineTimestamp(a, b) || a.order - b.order);
  const resolved = [];
  for (let i = 0; i < chronological.length;) {
    const bucket = [chronological[i]];
    let j = i + 1;
    while (j < chronological.length && chronological[j].timestamp === chronological[i].timestamp) {
      bucket.push(chronological[j]);
      j += 1;
    }
    resolved.push(...blackboardResolveTimelineBucket(bucket));
    i = j;
  }
  return resolved.slice(-BLACKBOARD_MAX_TIMELINE_EVENTS).map((event, index, list) => ({ ...event, isLast: index === list.length - 1 }));
}

function blackboardResolveTimelineBucket(bucket) {
  if (!Array.isArray(bucket) || bucket.length <= 1) return bucket || [];
  const priority = {
    project_created: 0,
    hint_added: 1,
    intent_declared: 2,
    intent_concluded: 3,
    project_completed: 4,
  };
  return [...bucket].sort((a, b) => {
    if (a.intentId && b.intentId && a.intentId === b.intentId) {
      if (a.type === 'intent_declared' && (b.type === 'intent_concluded' || b.type === 'project_completed')) return -1;
      if (b.type === 'intent_declared' && (a.type === 'intent_concluded' || a.type === 'project_completed')) return 1;
    }
    const aDependsOnB = a.sourceFactIds?.includes(b.producedFactId);
    const bDependsOnA = b.sourceFactIds?.includes(a.producedFactId);
    if (aDependsOnB && !bDependsOnA) return 1;
    if (bDependsOnA && !aDependsOnB) return -1;
    return (priority[a.type] ?? 9) - (priority[b.type] ?? 9) || a.order - b.order;
  });
}

function blackboardTimelineMeta(event) {
  const meta = Array.isArray(event?.meta) ? event.meta : [];
  return meta.filter(Boolean).map((item) => blackboardCleanSummary(item, '', 42)).join(' · ');
}

function blackboardTimelineTargetNodeId(event, layout = null) {
  if (!event) return '';
  if (event.type === 'intent_declared' && event.intentId) return event.intentId;
  if ((event.type === 'intent_concluded' || event.type === 'project_completed') && event.producedFactId) return event.producedFactId;
  if (event.targetType === 'hint' && event.targetId) return event.targetId;
  if (event.targetId) return event.targetId;
  if (event.intentId) return event.intentId;
  const firstNode = Array.isArray(layout?.nodes) ? layout.nodes[0] : null;
  return firstNode?.id || '';
}

function selectBlackboardGraphNode(nodeId, layout, options = {}) {
  if (!nodeId || !layout?.nodes?.length) return null;
  const node = layout.nodes.find((item) => item.id === nodeId);
  if (!node) return null;
  if (blackboardGraphNodesEl && typeof blackboardGraphNodesEl.querySelectorAll === 'function') {
    const nodeEls = Array.from(blackboardGraphNodesEl.querySelectorAll('.blackboard-graph-node[data-node-id]'));
    nodeEls.forEach((el) => el.classList?.remove('selected'));
    const selector = `.blackboard-graph-node[data-node-id="${String(nodeId).replace(/"/g, '\\"')}"]`;
    const selected = typeof blackboardGraphNodesEl.querySelector === 'function'
      ? blackboardGraphNodesEl.querySelector(selector)
      : nodeEls.find((el) => el.dataset?.nodeId === nodeId);
    if (selected) {
      selected.classList?.add('selected');
      if (options.scroll !== false && typeof selected.scrollIntoView === 'function') {
        selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
  }
  showBlackboardGraphNodeDetail(node);
  return node;
}

function openBlackboardTimelineEntry(event, layout) {
  const nodeId = blackboardTimelineTargetNodeId(event, layout);
  return selectBlackboardGraphNode(nodeId, layout);
}

function setBlackboardGraphDetailBody(detail) {
  if (!blackboardGraphDetailBodyEl) return;
  if (typeof renderMarkdown === 'function') {
    blackboardGraphDetailBodyEl.innerHTML = renderMarkdown(detail);
    return;
  }
  const plainText = String(detail || '');
  if ('textContent' in blackboardGraphDetailBodyEl) blackboardGraphDetailBodyEl.textContent = plainText;
  if ('innerHTML' in blackboardGraphDetailBodyEl) {
    const escape = typeof escapeHtml === 'function'
      ? escapeHtml
      : (value) => String(value || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    blackboardGraphDetailBodyEl.innerHTML = escape(plainText).replace(/\n/g, '<br>');
  }
}

function clearBlackboardGraphDetailBody() {
  if (!blackboardGraphDetailBodyEl) return;
  if ('innerHTML' in blackboardGraphDetailBodyEl) blackboardGraphDetailBodyEl.innerHTML = '';
  if ('textContent' in blackboardGraphDetailBodyEl) blackboardGraphDetailBodyEl.textContent = '';
}

function renderBlackboardTimeline(graph, layout) {
  const timelineEl = typeof blackboardGraphTimelineEl !== 'undefined' ? blackboardGraphTimelineEl : null;
  if (!timelineEl) return;
  const events = blackboardTimelineEvents(graph);
  if (!events.length) {
    timelineEl.innerHTML = '<div class="blackboard-graph-timeline-empty">暂无时间线。</div>';
    return;
  }
  timelineEl.innerHTML = events.map((event) => `
    <button class="blackboard-graph-timeline-item ${escapeHtml(event.type)}" type="button" role="listitem" data-event-id="${escapeHtml(event.id)}" data-node-id="${escapeHtml(blackboardTimelineTargetNodeId(event, layout))}" title="${escapeHtml(blackboardCleanDetail(event.title, blackboardTimelineLabel(event.type)))}">
      <span class="blackboard-graph-timeline-dot" aria-hidden="true"></span>
      <span class="blackboard-graph-timeline-main">
        <span class="blackboard-graph-timeline-row">
          <strong>${escapeHtml(blackboardTimelineLabel(event.type))}</strong>
          <span>${escapeHtml(event.actor || '')}</span>
        </span>
        <span class="blackboard-graph-timeline-title">${escapeHtml(blackboardTimelineTitle(event))}</span>
        <span class="blackboard-graph-timeline-meta">${escapeHtml(blackboardTimelineMeta(event))}</span>
      </span>
    </button>`).join('');
  if (typeof timelineEl.querySelectorAll !== 'function') return;
  const itemEls = Array.from(timelineEl.querySelectorAll('.blackboard-graph-timeline-item[data-event-id]'));
  const byId = new Map(events.map((event) => [event.id, event]));
  itemEls.forEach((el) => {
    el.addEventListener('click', () => {
      itemEls.forEach((item) => item.classList.remove('selected'));
      el.classList.add('selected');
      openBlackboardTimelineEntry(byId.get(el.dataset.eventId), layout);
    });
  });
}

function showBlackboardGraphNodeDetail(node) {
  if (!blackboardGraphDetailEl || !blackboardGraphDetailTitleEl || !blackboardGraphDetailBodyEl || !node) return;
  const title = node.title || blackboardNodeKindLabel(node.kind);
  const detailOptions = node.kind === 'fact' ? { limit: BLACKBOARD_FINAL_DETAIL_LIMIT } : {};
  const detail = blackboardCleanDetail(node.detail || node.body || title, node.body || title, detailOptions);
  blackboardGraphDetailTitleEl.textContent = title;
  setBlackboardGraphDetailBody(detail);
  blackboardGraphDetailEl.classList.remove('hidden');
  blackboardGraphDetailEl.setAttribute('aria-hidden', 'false');
}

function hideBlackboardGraphNodeDetail() {
  if (!blackboardGraphDetailEl) return;
  blackboardGraphDetailEl.classList.add('hidden');
  blackboardGraphDetailEl.setAttribute('aria-hidden', 'true');
  if (blackboardGraphDetailTitleEl) blackboardGraphDetailTitleEl.textContent = '节点详情';
  clearBlackboardGraphDetailBody();
}

function bindBlackboardGraphNodeDetails(layout) {
  if (!blackboardGraphNodesEl || !layout?.nodes?.length) {
    hideBlackboardGraphNodeDetail();
    return;
  }
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  if (typeof blackboardGraphNodesEl.querySelectorAll !== 'function') return;
  const nodeEls = Array.from(blackboardGraphNodesEl.querySelectorAll('.blackboard-graph-node[data-node-id]'));
  nodeEls.forEach((el) => {
    el.addEventListener('click', () => {
      if (!byId.has(el.dataset.nodeId)) return;
      selectBlackboardGraphNode(el.dataset.nodeId, layout, { scroll: false });
    });
  });
}

let blackboardGraphAnimationFrame = 0;
let blackboardGraphAnimationStartedAt = 0;
let blackboardGraphAnimationLayout = null;

function blackboardEdgeCurve(edge) {
  const from = edge.fromNode;
  const to = edge.toNode;
  const startX = from.x + from.width;
  const startY = from.y + from.height / 2;
  const endX = to.x;
  const endY = to.y + to.height / 2;
  const dx = Math.max(70, Math.abs(endX - startX) * 0.46);
  const direction = endX >= startX ? 1 : -1;
  return {
    p0: { x: startX, y: startY },
    p1: { x: startX + dx * direction, y: startY },
    p2: { x: endX - dx * direction, y: endY },
    p3: { x: endX, y: endY },
  };
}

function blackboardBezierPoint(curve, t) {
  const clamped = Math.max(0, Math.min(1, Number(t) || 0));
  const inv = 1 - clamped;
  const a = inv * inv * inv;
  const b = 3 * inv * inv * clamped;
  const c = 3 * inv * clamped * clamped;
  const d = clamped * clamped * clamped;
  return {
    x: a * curve.p0.x + b * curve.p1.x + c * curve.p2.x + d * curve.p3.x,
    y: a * curve.p0.y + b * curve.p1.y + c * curve.p2.y + d * curve.p3.y,
  };
}

function blackboardGraphColor(kind, alpha = 1) {
  const colors = {
    concluded: `rgba(52, 211, 153, ${alpha})`,
    open: `rgba(244, 197, 66, ${alpha})`,
    failed: `rgba(239, 71, 111, ${alpha})`,
    running: `rgba(244, 197, 66, ${alpha})`,
    origin: `rgba(20, 184, 166, ${alpha})`,
    goal: `rgba(239, 71, 111, ${alpha})`,
    hint: `rgba(34, 184, 166, ${alpha})`,
    intent: `rgba(117, 104, 244, ${alpha})`,
    openNode: `rgba(244, 197, 66, ${alpha})`,
    fact: `rgba(109, 117, 238, ${alpha})`,
  };
  return colors[kind] || colors.fact;
}

function blackboardGraphNodeColor(node, alpha = 1) {
  if (node?.kind === 'open') return blackboardGraphColor('openNode', alpha);
  if (node?.kind === 'origin' || node?.kind === 'goal' || node?.kind === 'hint' || node?.kind === 'intent') {
    return blackboardGraphColor(node.kind, alpha);
  }
  if (node?.status === 'running') return blackboardGraphColor('running', alpha);
  if (node?.status === 'failed' || node?.kind === 'error') return blackboardGraphColor('failed', alpha);
  return blackboardGraphColor('fact', alpha);
}

function blackboardGraphDrawFlowParticle(ctx, edge, elapsedMs, index) {
  blackboardGraphDrawEdgeComet(ctx, edge, elapsedMs, index);
}

function blackboardGraphDrawEdgeComet(ctx, edge, elapsedMs, index, pass = 0) {
  const curve = blackboardEdgeCurve(edge);
  const speed = edge.kind === 'open' ? 1050 : edge.kind === 'failed' ? 1450 : 1950;
  const offset = ((elapsedMs + index * 330 + pass * 270) % speed) / speed;
  const point = blackboardBezierPoint(curve, offset);
  const previous = blackboardBezierPoint(curve, Math.max(0, offset - 0.025));
  const angle = Math.atan2(point.y - previous.y, point.x - previous.x);
  const color = blackboardGraphColor(edge.kind, edge.kind === 'open' ? 0.92 : 0.78);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = color;
  ctx.shadowBlur = edge.kind === 'open' ? 15 : 10;
  for (let tail = 7; tail >= 1; tail -= 1) {
    const tailT = offset - tail * 0.018;
    if (tailT <= 0) continue;
    const tailPoint = blackboardBezierPoint(curve, tailT);
    const nextPoint = blackboardBezierPoint(curve, Math.min(1, tailT + 0.014));
    ctx.strokeStyle = blackboardGraphColor(edge.kind, (edge.kind === 'open' ? 0.2 : 0.14) * (1 - tail / 8));
    ctx.lineWidth = Math.max(1, (edge.kind === 'open' ? 5 : 4) * (1 - tail / 9));
    ctx.beginPath();
    ctx.moveTo(tailPoint.x, tailPoint.y);
    ctx.lineTo(nextPoint.x, nextPoint.y);
    ctx.stroke();
  }
  ctx.translate(point.x, point.y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(0, 0, edge.kind === 'open' ? 5.5 : 4.5, 2.3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function blackboardGraphDrawNodePulse(ctx, node, elapsedMs, index) {
  const centerX = node.x + node.width / 2;
  const centerY = node.y + node.height / 2;
  const baseRadius = Math.max(node.width, node.height) * (node.kind === 'open' ? 0.58 : 0.47);
  const active = node.status === 'running' || node.kind === 'open';
  const phase = ((elapsedMs + index * 170) % (active ? 1500 : 3600)) / (active ? 1500 : 3600);
  const radius = baseRadius + phase * (active ? 18 : 8);
  const alpha = active ? (0.34 * (1 - phase)) : (0.12 * (1 - phase));
  const color = blackboardGraphNodeColor(node, alpha);
  const glow = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
  glow.addColorStop(0, blackboardGraphNodeColor(node, active ? 0.22 : 0.11));
  glow.addColorStop(0.55, color);
  glow.addColorStop(1, blackboardGraphNodeColor(node, 0));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.fill();

  if (!active) return;
  ctx.strokeStyle = blackboardGraphNodeColor(node, 0.42 * (1 - phase));
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(centerX, centerY, Math.max(12, radius * 0.62), 0, Math.PI * 2);
  ctx.stroke();

  const orbit = baseRadius * 0.72 + 7;
  const dotAngle = (elapsedMs / 520 + index) % (Math.PI * 2);
  ctx.fillStyle = blackboardGraphNodeColor(node, 0.88);
  ctx.shadowColor = blackboardGraphNodeColor(node, 0.9);
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.arc(centerX + Math.cos(dotAngle) * orbit, centerY + Math.sin(dotAngle) * orbit, 2.4, 0, Math.PI * 2);
  ctx.fill();
}

function blackboardGraphDrawGrid(ctx, width, height, elapsedMs) {
  const grid = 32;
  const offset = (elapsedMs * 0.015) % grid;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
  for (let x = -grid + offset; x <= width + grid; x += grid) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = -grid + offset; y <= height + grid; y += grid) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(148, 163, 184, 0.16)';
  for (let x = -grid + offset; x <= width + grid; x += grid) {
    for (let y = -grid + offset; y <= height + grid; y += grid) {
      ctx.fillRect(Math.round(x) - 0.5, Math.round(y) - 0.5, 1, 1);
    }
  }
  ctx.restore();
}

function blackboardGraphDrawScanBand(ctx, width, height, elapsedMs) {
  const travel = width + height + 280;
  const x = ((elapsedMs * 0.11) % travel) - 180;
  const band = ctx.createLinearGradient(x - 90, 0, x + 90, 0);
  band.addColorStop(0, 'rgba(20, 184, 166, 0)');
  band.addColorStop(0.48, 'rgba(20, 184, 166, 0.09)');
  band.addColorStop(0.52, 'rgba(244, 197, 66, 0.16)');
  band.addColorStop(1, 'rgba(117, 104, 244, 0)');
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.translate(width / 2, height / 2);
  ctx.rotate(-0.32);
  ctx.translate(-width / 2, -height / 2);
  ctx.fillStyle = band;
  ctx.fillRect(x - 90, -height, 180, height * 3);
  ctx.restore();
}

function drawBlackboardGraphAnimation(layout, elapsedMs) {
  if (!blackboardGraphAnimationCanvasEl || !layout) return;
  const ctx = blackboardGraphAnimationCanvasEl.getContext('2d');
  if (!ctx) return;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(layout.width));
  const height = Math.max(1, Math.round(layout.height));
  const pixelWidth = Math.round(width * ratio);
  const pixelHeight = Math.round(height * ratio);
  if (blackboardGraphAnimationCanvasEl.width !== pixelWidth || blackboardGraphAnimationCanvasEl.height !== pixelHeight) {
    blackboardGraphAnimationCanvasEl.width = pixelWidth;
    blackboardGraphAnimationCanvasEl.height = pixelHeight;
    blackboardGraphAnimationCanvasEl.style.width = `${width}px`;
    blackboardGraphAnimationCanvasEl.style.height = `${height}px`;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, 'rgba(20, 184, 166, 0.06)');
  gradient.addColorStop(0.5, 'rgba(117, 104, 244, 0.05)');
  gradient.addColorStop(1, 'rgba(244, 197, 66, 0.05)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  blackboardGraphDrawGrid(ctx, width, height, elapsedMs);
  blackboardGraphDrawScanBand(ctx, width, height, elapsedMs);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const [index, node] of layout.nodes.entries()) {
    blackboardGraphDrawNodePulse(ctx, node, elapsedMs, index);
  }
  for (const [index, edge] of layout.edges.entries()) {
    const curve = blackboardEdgeCurve(edge);
    ctx.strokeStyle = blackboardGraphColor(edge.kind, edge.kind === 'open' ? 0.16 : 0.1);
    ctx.lineWidth = edge.kind === 'open' ? 8 : 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(curve.p0.x, curve.p0.y);
    ctx.bezierCurveTo(curve.p1.x, curve.p1.y, curve.p2.x, curve.p2.y, curve.p3.x, curve.p3.y);
    ctx.stroke();
    for (let pass = 0; pass < 3; pass += 1) {
      blackboardGraphDrawEdgeComet(ctx, edge, elapsedMs, index, pass);
    }
  }
  ctx.restore();
}

function stopBlackboardGraphAnimation(clear = false) {
  if (blackboardGraphAnimationFrame) {
    cancelAnimationFrame(blackboardGraphAnimationFrame);
    blackboardGraphAnimationFrame = 0;
  }
  blackboardGraphAnimationLayout = null;
  blackboardGraphAnimationStartedAt = 0;
  if (clear && blackboardGraphAnimationCanvasEl) {
    const ctx = blackboardGraphAnimationCanvasEl.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, blackboardGraphAnimationCanvasEl.width, blackboardGraphAnimationCanvasEl.height);
  }
}

function startBlackboardGraphAnimation(layout) {
  if (!blackboardGraphAnimationCanvasEl || !layout?.nodes?.length) return;
  blackboardGraphAnimationLayout = layout;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
    drawBlackboardGraphAnimation(layout, 0);
    return;
  }
  if (blackboardGraphAnimationFrame) return;
  const tick = (timestamp) => {
    if (!blackboardGraphAnimationLayout) return;
    if (!blackboardGraphAnimationStartedAt) blackboardGraphAnimationStartedAt = timestamp;
    drawBlackboardGraphAnimation(blackboardGraphAnimationLayout, timestamp - blackboardGraphAnimationStartedAt);
    blackboardGraphAnimationFrame = requestAnimationFrame(tick);
  };
  blackboardGraphAnimationFrame = requestAnimationFrame(tick);
}

function renderBlackboardGraphCanvas(graph) {
  if (!blackboardGraphCanvasEl || !blackboardGraphAnimationCanvasEl || !blackboardGraphSvgEl || !blackboardGraphNodesEl) return;
  const running = blackboardGraphIsRunning(graph);
  blackboardGraphCanvasEl.classList.toggle('is-running', running);
  const layout = layoutBlackboardGraph(graph);
  blackboardGraphCanvasEl.style.width = `${layout.width}px`;
  blackboardGraphCanvasEl.style.height = `${layout.height}px`;
  blackboardGraphAnimationCanvasEl.style.width = `${layout.width}px`;
  blackboardGraphAnimationCanvasEl.style.height = `${layout.height}px`;
  blackboardGraphSvgEl.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
  blackboardGraphSvgEl.setAttribute('width', String(layout.width));
  blackboardGraphSvgEl.setAttribute('height', String(layout.height));
  blackboardGraphSvgEl.innerHTML = `
    <defs>
      <marker id="blackboard-arrow-concluded" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#34d399"></path>
      </marker>
      <marker id="blackboard-arrow-open" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#f4c542"></path>
      </marker>
      <marker id="blackboard-arrow-failed" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="#ef476f"></path>
      </marker>
    </defs>
    ${layout.edges.map(blackboardRenderEdge).join('')}
    ${layout.edges.map(blackboardRenderEdgeLabel).join('')}`;
  blackboardGraphNodesEl.innerHTML = layout.nodes.map((node) => {
    const title = node.title || blackboardNodeKindLabel(node.kind);
    const kind = blackboardNodeDisplayKind(node.kind, node.status);
    const accessibleLabel = `${kind}：${title}，点击查看详情`;
    return `
    <button class="${escapeHtml(blackboardNodeClass(node))}" style="${blackboardNodeStyle(node)}" type="button" data-node-id="${escapeHtml(node.id)}" title="${escapeHtml(accessibleLabel)}" aria-label="${escapeHtml(accessibleLabel)}">
      <span class="blackboard-graph-node-kind">${escapeHtml(kind)}</span>
      <strong>${escapeHtml(title)}</strong>
    </button>`;
  }).join('');
  hideBlackboardGraphNodeDetail();
  bindBlackboardGraphNodeDetails(layout);
  renderBlackboardTimeline(graph, layout);
  if (running) {
    startBlackboardGraphAnimation(layout);
  } else {
    stopBlackboardGraphAnimation(false);
    drawBlackboardGraphAnimation(layout, 0);
  }
}

function clearBlackboardGraphSurface() {
  stopBlackboardGraphAnimation(true);
  if (blackboardGraphCanvasEl) blackboardGraphCanvasEl.classList.remove('is-running');
  if (blackboardGraphSvgEl) blackboardGraphSvgEl.innerHTML = '';
  if (blackboardGraphNodesEl) blackboardGraphNodesEl.innerHTML = '';
  if (typeof blackboardGraphTimelineEl !== 'undefined' && blackboardGraphTimelineEl) blackboardGraphTimelineEl.innerHTML = '';
  hideBlackboardGraphNodeDetail();
}

function setBlackboardGraphCollapsed(collapsed) {
  if (!blackboardGraphFloatEl) return;
  blackboardGraphFloatEl.classList.toggle('collapsed', !!collapsed);
  if (blackboardGraphBodyEl) blackboardGraphBodyEl.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
  if (blackboardGraphToggleBtn) {
    blackboardGraphToggleBtn.setAttribute('aria-expanded', String(!collapsed));
    blackboardGraphToggleBtn.title = collapsed ? '展开黑板图' : '收起黑板图';
    blackboardGraphToggleBtn.setAttribute('aria-label', blackboardGraphToggleBtn.title);
  }
  if (blackboardGraphCollapseBtn) {
    blackboardGraphCollapseBtn.setAttribute('aria-expanded', String(!collapsed));
    blackboardGraphCollapseBtn.disabled = !!collapsed;
    blackboardGraphCollapseBtn.title = '收起黑板图';
    blackboardGraphCollapseBtn.setAttribute('aria-label', '收起黑板图');
  }
}

function toggleBlackboardGraphCollapsed() {
  const sess = state.sessions.get(state.activeId);
  if (sess) sess.blackboardGraphCollapsed = !sess.blackboardGraphCollapsed;
  setBlackboardGraphCollapsed(sess ? sess.blackboardGraphCollapsed : true);
  renderBlackboardGraph();
}

function collapseBlackboardGraph() {
  const sess = state.sessions.get(state.activeId);
  if (sess) sess.blackboardGraphCollapsed = true;
  setBlackboardGraphCollapsed(true);
  clearBlackboardGraphSurface();
}

function renderBlackboardGraph() {
  const sess = state.sessions.get(state.activeId);
  if (!blackboardGraphFloatEl || !blackboardGraphCanvasEl || !blackboardGraphAnimationCanvasEl || !blackboardGraphSvgEl || !blackboardGraphNodesEl) return;
  const collapsed = sess ? sess.blackboardGraphCollapsed !== false : true;
  setBlackboardGraphCollapsed(collapsed);
  if (collapsed) {
    if (blackboardGraphSummaryEl) blackboardGraphSummaryEl.textContent = '已收起';
    if (blackboardGraphEmptyEl) blackboardGraphEmptyEl.classList.add('hidden');
    clearBlackboardGraphSurface();
    return;
  }
  const graph = blackboardGraphFromSession(sess);
  const facts = graph.facts || [];
  const intents = graph.intents || [];
  const hints = graph.hints || [];
  const summary = graph.summary || {};
  if (blackboardGraphSummaryEl) {
    blackboardGraphSummaryEl.textContent = facts.length
      ? `${summary.factCount || facts.length} Facts · ${summary.intentCount || intents.length} Intents · ${summary.openIntentCount || 0} Open`
      : '暂无事实';
  }
  const visible = facts.length || intents.length || hints.length;
  if (blackboardGraphEmptyEl) blackboardGraphEmptyEl.classList.toggle('hidden', !!visible);
  if (visible) {
    renderBlackboardGraphCanvas(graph);
  }
  else {
    clearBlackboardGraphSurface();
  }
}

// ─── Session management ──────────────────────────────────────────────────
function isUntitledSessionTitle(title) {
  return !title || /^new\s+chat$/i.test(String(title).trim());
}

function createLocalSession(id, title, bridgeSessionId = id, config = null) {
  const mergedConfig = { ...state.defaultConfig, ...(config || {}) };
  const now = Date.now() / 1000;
  const sess = {
    id, bridgeSessionId, title: title || 'New chat', messages: [], cwd: null,
    createdAt: now,
    updatedAt: now,
    bridgeMsgSeq: 0,
    untitled: isUntitledSessionTitle(title),
    goalPlan: [],
    goalPlanCollapsed: true,
    blackboardGraphCollapsed: true,
    composerDraft: { text: '', images: [], files: [] },
    composerModelValue: String(mergedConfig.llmNo || 0),
    composerApiModelValue: '',
    piSlashCommands: null,
    slashCommandsPromise: null,
    config: mergedConfig,
    role: null,
    managed: false,
    taskId: null,
    category: null,
    parentMainSessionId: null,
    tmuxTarget: null,
    diagnostics: [],
  };
  syncComposerApiModelFromSelectedProfile(sess);
  getSessionRuntime(sess);
  // Keep freshly-created chats visually quiet: the empty state is enough guidance.
  state.sessions.set(id, sess);
  recordSessionPosition(sess);
  sortSessionsByPosition();
  persistSessionOrder();
  renderSessionList();
  return sess;
}

function setActiveSession(id) {
  const sess = state.sessions.get(id);
  if (!sess || isClosedSessionId(id)) return;
  state.sessionSelectionVersion += 1;
  ensureChatView();
  // Save scroll position of current session before switching
  if (state.activeId && state.activeId !== id) window.SecHeurTrajectoryViewer?.close?.();
  if (state.activeId) {
    saveActiveComposerDraft();
    const prevRuntime = state.runtimeBySessionId.get(state.activeId);
    if (prevRuntime) prevRuntime.scrollPos = messagesEl.scrollTop;
  }
  state.activeId = id;
  try { sessionStorage.setItem('secheur:active-session', sess.bridgeSessionId || id); }
  catch (_) { /* 存储不可用时仍可切换会话。 */ }
  if (sessionTitleEl) sessionTitleEl.textContent = sess.title;
  renderMessages();
  renderGoalPlan();
  renderBlackboardGraph();
  renderSessionList();
  renderDiagnostics();
  restoreComposerDraft(sess);
  renderComposerControls();
  ensureComposerApiModelsForActiveSession();
  void loadSessionSlashCommands(sess);
  const runtime = getSessionRuntime(sess);
  // 非活动会话只保留轻量摘要。切换时再加载最近一页，旧请求即使乱序返回也只
  // 更新对应 session，不会覆盖当前选中的会话。
  let hydrationPromise = null;
  const hasRemoteHistory = Number(sess.bridgeMsgSeq || 0) > 0 || runtime.busy;
  if (state.bridgeReady && sess.bridgeSessionId && hasRemoteHistory && !runtime.messagesLoaded && !runtime.messagesLoading) {
    hydrationPromise = hydrateSessionMessages(sess, { limit: SESSION_HISTORY_BOOTSTRAP_LIMIT })
      .then(() => {
        if (isActiveSession(sess)) {
          renderMessages();
          renderSessionList();
        }
      })
      .catch((error) => {
        if (isActiveSession(sess)) addDiagnostic('warn', '加载会话历史失败', error);
      });
  }
  if (state.bridgeReady && sess.bridgeSessionId && sess.title !== '定时任务') {
    // 只记录当前活动会话，不把查看旧会话算作最近使用。
    bridgeApi.rpc('session/activate', { sessionId: sess.bridgeSessionId }).then((result) => {
      if (result?.session) applyBridgeSessionSnapshot(sess, result.session);
      renderSessionList();
    }).catch((err) => addDiagnostic('warn', '保存最近会话失败', err));
  }
  scheduleConversationToolSync(sess, 0);
  setBusy(runtime.busy, runtime.busy ? 'Agent 正在回复…' : null, sess);
  // When switching to a session that is still running, ensure the live draft
  // is rendered immediately and polling is active (it may have been started
  // earlier but its render calls were no-ops because the session wasn't active).
  if (runtime.busy && hydrationPromise) {
    // 先完成首屏 hydrate，再启动流式轮询，避免同一会话并发发起两次全量请求。
    void hydrationPromise.then(() => {
      if (!isActiveSession(sess) || !runtime.busy || runtime.polling) return;
      runtime.forcePollOnce = true;
      pollSessionMessages(sess);
    });
  } else if (runtime.busy && runtime.messagesLoading) {
    // 已有 hydrate 请求时不要并发启动增量轮询；请求完成后由其回调接管。
    const pendingHydration = runtime.messagesHydrationPromise;
    if (pendingHydration) {
      void pendingHydration.then(() => {
        if (!isActiveSession(sess) || !runtime.busy || runtime.polling || runtime.messagesLoading) return;
        runtime.forcePollOnce = true;
        pollSessionMessages(sess);
      }, () => undefined);
    }
  } else if (runtime.busy) {
    const draft = runtime.assistantDraft;
    if (draft && !draft.finalized) {
      renderAssistantDraftInPlace(sess, draft);
    }
    // Restart polling if it stopped (e.g. page reload or race condition)
    if (!runtime.polling) {
      runtime.forcePollOnce = true;
      pollSessionMessages(sess);
    } else {
      // Polling is running but was rendering as no-op while we were away.
      // Do an immediate one-shot poll to refresh the view right now.
      (async () => {
        try {
          const res = await bridgeApi.pollSession(sess.bridgeSessionId || sess.id, runtime.lastPolledMessageId || 0);
          if (res?.error) return;
          const result = res.result || res;
          for (const msg of (result.messages || [])) upsertPolledMessage(sess, msg, { partial: false });
          if (result.partial) upsertPolledMessage(sess, result.partial, { partial: true });
        } catch(e) { /* ignore, regular polling will handle it */ }
      })();
    }
  }
}

function renderSessionList() {
  sortSessionsByPosition();
  const newBtn = document.getElementById('new-session-btn');
  const scrollTop = sessionListEl.scrollTop;
  const tabs = new Map([...sessionListEl.querySelectorAll('.session-tab')].map((el) => [el.dataset.sessionId, el]));
  for (const [id, tab] of tabs) {
    if (!state.sessions.has(id)) tab.remove();
  }
  let cursor = sessionListEl.querySelector('.session-tab') || newBtn;
  for (const sess of state.sessions.values()) {
    const active = sess.id === state.activeId;
    const runtime = getSessionRuntime(sess);
    const busy = !!(runtime && runtime.busy);
    const tabStatus = busy ? '运行中' : '空闲';
    const roleLabel = sess.role === 'main' ? 'Main Agent' : sess.role === 'solver' ? `Solver${sess.category ? ` · ${sess.category}` : ''}` : '';
    const taskLabel = sess.taskId ? ` · ${sess.taskId}` : '';
    const tabLabel = `${sess.title}${roleLabel ? `，${roleLabel}${taskLabel}` : ''}，${tabStatus}${active ? '，当前对话' : ''}`;
    const existing = tabs.get(sess.id);
    if (existing) {
      existing.classList.toggle('active', active);
      existing.setAttribute('aria-selected', active ? 'true' : 'false');
      existing.setAttribute('aria-label', tabLabel);
      existing.title = tabLabel;
      existing.querySelector('.tab-icon').classList.toggle('busy', busy);
      const label = existing.querySelector('.tab-label');
      const metaText = `${roleLabel}${taskLabel}`;
      if (existing.dataset.title !== sess.title || existing.dataset.meta !== metaText) {
        label.textContent = sess.title;
        if (metaText) label.appendChild(createEl('span', 'tab-meta', metaText));
        existing.dataset.title = sess.title;
        existing.dataset.meta = metaText;
        for (const [selector, title] of [
          ['.tab-export', `导出对话：${sess.title}`],
          ['.tab-ctf-field-save', `保存到 CTF Field：${sess.title}`],
          ['.tab-log', `查看运行日志：${sess.title}`],
          ['.tab-close', `关闭对话：${sess.title}`],
        ]) {
          const button = existing.querySelector(selector);
          button.title = title;
          button.setAttribute('aria-label', title);
        }
      }
      if (existing !== cursor) sessionListEl.insertBefore(existing, cursor);
      cursor = existing.nextElementSibling;
      continue;
    }
    const item = document.createElement('div');
    item.className = 'session-tab' + (active ? ' active' : '');
    item.setAttribute('role', 'tab');
    item.setAttribute('aria-selected', active ? 'true' : 'false');
    item.setAttribute('aria-label', tabLabel);
    item.setAttribute('data-session-id', sess.id);
    item.dataset.title = sess.title;
    item.dataset.meta = `${roleLabel}${taskLabel}`;
    item.tabIndex = 0;
    item.title = tabLabel;
    // ─── Drag-and-drop reorder ───
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', sess.id);
      e.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      sessionListEl.querySelectorAll('.session-tab.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const draggedId = e.dataTransfer.getData('text/plain');
      if (draggedId && draggedId !== sess.id) {
        reorderSession(draggedId, sess.id);
      }
    });
    const icon = document.createElement('span');
    icon.className = 'tab-icon';
    icon.innerHTML = projectShieldIconSvg();
    if (busy) icon.classList.add('busy');
    item.appendChild(icon);
    // Tab label
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = sess.title;
    if (roleLabel || taskLabel) {
      const meta = document.createElement('span');
      meta.className = 'tab-meta';
      meta.textContent = `${roleLabel}${taskLabel}`;
      label.appendChild(meta);
    }
    item.appendChild(label);
    const actions = document.createElement('span');
    actions.className = 'tab-actions';
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'tab-action tab-export';
    exportBtn.setAttribute('aria-label', `导出对话：${sess.title}`);
    exportBtn.title = `导出对话：${sess.title}`;
    exportBtn.innerHTML = downloadIconSvg(12);
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      exportSession(sess.id).catch((err) => showError('导出对话失败：' + (err.message || err)));
    });
    const ctfFieldBtn = document.createElement('button');
    ctfFieldBtn.type = 'button';
    ctfFieldBtn.className = 'tab-action tab-ctf-field-save';
    ctfFieldBtn.setAttribute('aria-label', `保存到 CTF Field：${sess.title}`);
    ctfFieldBtn.title = `保存到 CTF Field：${sess.title}`;
    ctfFieldBtn.innerHTML = saveToFieldIconSvg(12);
    ctfFieldBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      saveSessionToCtfField(sess.id).catch((err) => showError('保存到 CTF Field 失败：' + (err.message || err)));
    });
    const logBtn = document.createElement('button');
    logBtn.type = 'button';
    logBtn.className = 'tab-action tab-log';
    logBtn.setAttribute('aria-label', `查看运行日志：${sess.title}`);
    logBtn.title = `查看运行日志：${sess.title}`;
    logBtn.innerHTML = listLogIconSvg(12);
    logBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSessionRunLog(sess.id).catch((err) => showError('查看运行日志失败：' + (err.message || err)));
    });
    actions.appendChild(exportBtn);
    actions.appendChild(ctfFieldBtn);
    actions.appendChild(logBtn);
    item.appendChild(actions);
    // Close button (Chrome-style icon)
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tab-close';
    closeBtn.setAttribute('aria-label', `关闭对话：${sess.title}`);
    closeBtn.title = `关闭对话：${sess.title}`;
    closeBtn.innerHTML = closeIconSvg(12);
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSession(sess.id);
    });
    item.appendChild(closeBtn);
    item.addEventListener('click', () => setActiveSession(sess.id));
    item.addEventListener('keydown', (e) => {
      if (e.target === item && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        setActiveSession(sess.id);
      }
    });
    sessionListEl.insertBefore(item, cursor);
  }
  sessionListEl.scrollTop = scrollTop;
}

// ─── Tab drag reorder helper ─────────────────────────────────────────────────
function reorderSession(draggedId, targetId) {
  const entries = [...state.sessions.entries()];
  const fromIdx = entries.findIndex(([id]) => id === draggedId);
  const toIdx = entries.findIndex(([id]) => id === targetId);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
  const [moved] = entries.splice(fromIdx, 1);
  entries.splice(toIdx, 0, moved);
  state.sessions = new Map(entries);
  for (const [, sess] of [...entries].reverse()) recordSessionPosition(sess, true);
  persistSessionOrder();
  renderSessionList();
}

function safeDownloadName(text, fallback = 'session') {
  const raw = String(text || fallback).trim() || fallback;
  return raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, '-').slice(0, 80) || fallback;
}

function formatEventTime(ts) {
  const value = Number(ts || 0);
  if (!Number.isFinite(value) || value <= 0) return '';
  return new Date(value * 1000).toLocaleString();
}

function formatSessionExportMarkdown(payload) {
  const session = payload?.session || {};
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const events = Array.isArray(payload?.runtimeLog) ? payload.runtimeLog : [];
  const lines = [
    `# ${session.title || 'SecHeur Agent 会话导出'}`,
    '',
    `- 会话 ID：${payload?.sessionId || session.id || ''}`,
    `- 工作目录：${session.cwd || ''}`,
    `- 导出时间：${formatEventTime(payload?.exportedAt) || new Date().toLocaleString()}`,
    '',
    '## 对话',
    '',
  ];
  if (!messages.length) {
    lines.push('暂无消息。', '');
  } else {
    for (const msg of messages) {
      const role = msg.role || 'message';
      const stamp = formatEventTime(msg.ts);
      lines.push(`### ${role}${stamp ? ` · ${stamp}` : ''}`);
      lines.push('');
      lines.push(messageContentText(msg.content).trim() || '(空消息)');
      lines.push('');
    }
  }
  lines.push('## 运行日志', '');
  if (!events.length) {
    lines.push('暂无运行日志。', '');
  } else {
    for (const event of events) {
      const stamp = formatEventTime(event.ts);
      const suffix = event.detail ? ` - ${event.detail}` : '';
      lines.push(`- ${stamp ? `${stamp} ` : ''}${event.event || 'event'} [${event.status || ''}]${suffix}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function downloadTextFile(filename, text, type = 'text/markdown;charset=utf-8') {
  const blob = new Blob([String(text || '')], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportSession(sessId) {
  const sess = state.sessions.get(sessId);
  if (!sess) return;
  const sessionId = sess.bridgeSessionId || sess.id;
  const dialog = document.createElement('dialog');
  dialog.className = 'session-log-panel';
  dialog.id = 'session-export-dialog';
  dialog.setAttribute('aria-labelledby', 'session-export-title');
  dialog.innerHTML = `
    <header class="diagnostics-header"><div>
      <h2 id="session-export-title">导出对话</h2><p>正在读取对话…</p>
    </div></header>
    <textarea class="session-log-content" rows="12" readonly aria-label="导出内容"></textarea>
    <footer class="diagnostics-footer">
      <button class="btn" type="button" data-action="close">关闭</button>
      <button class="btn primary" type="button" data-action="download" disabled>下载 Markdown</button>
    </footer>`;
  const download = dialog.querySelector('[data-action="download"]');
  dialog.querySelector('[data-action="close"]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  document.body.appendChild(dialog);
  dialog.showModal();
  try {
    const payload = await bridgeApi.rpc('session/export', { sessionId });
    if (payload?.error) throw new Error(payload.error.message || payload.error);
    if (!dialog.open) return;
    const markdown = formatSessionExportMarkdown(payload);
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${safeDownloadName(sess.title, 'secheur-session')}-${date}.md`;
    dialog.querySelector('p').textContent = filename;
    dialog.querySelector('textarea').value = markdown;
    download.disabled = false;
    download.onclick = () => {
      downloadTextFile(filename, markdown);
      dialog.querySelector('p').textContent = '已请求下载。若未开始，可选中下方内容复制保存。';
      addDiagnostic('info', `已导出对话：${sess.title}`, { sessionId });
    };
  } catch (error) {
    dialog.close();
    throw error;
  }
}

function defaultCtfFieldApiBase() {
  const protocol = location.protocol === 'https:' ? 'https:' : 'http:';
  const host = location.hostname || '127.0.0.1';
  return `${protocol}//${host}:14230/api`;
}

function ctfFieldApiBase() {
  const saved = localStorage.getItem('secheur:ctf-field-api-base');
  return String(saved || defaultCtfFieldApiBase()).replace(/\/+$/, '');
}

async function ctfFieldApi(path, options = {}) {
  const res = await fetch(`${ctfFieldApiBase()}${path}`, {
    signal: AbortSignal.timeout(15000),
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `CTF Field HTTP ${res.status}`);
  }
  return data;
}

function promptCtfFieldTarget(guessedTargetId) {
  const dialog = document.createElement('dialog');
  dialog.className = 'session-log-panel';
  dialog.id = 'ctf-field-save-dialog';
  dialog.setAttribute('aria-labelledby', 'ctf-field-save-title');
  dialog.innerHTML = `
    <header class="diagnostics-header"><div>
      <h2 id="ctf-field-save-title">保存到 CTF Field</h2><p></p>
    </div></header>
    <form method="dialog">
      <div class="diagnostics-header">
        <label>Target ID <input name="targetId" aria-label="Target ID" required autofocus></label>
      </div>
      <footer class="diagnostics-footer">
        <button class="btn" type="button" data-action="cancel">取消</button>
        <button class="btn primary" type="submit" value="save">保存</button>
      </footer>
    </form>`;
  dialog.querySelector('p').textContent = ctfFieldApiBase();
  dialog.querySelector('input').value = guessedTargetId;
  dialog.querySelector('[data-action="cancel"]').onclick = () => dialog.close();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      const targetId = dialog.returnValue === 'save' ? cleanTargetId(dialog.querySelector('input').value) : '';
      dialog.remove();
      resolve(targetId);
    }, { once: true });
    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

function messageContentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
      try {
        return JSON.stringify(part);
      } catch (_) {
        return String(part || '');
      }
    }).filter(Boolean).join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch (_) {
    return String(content || '');
  }
}

function cleanTargetId(value) {
  return String(value || '')
    .trim()
    .replace(/^[`"'(<\[]+/, '')
    .replace(/[`"',.;:，。；：、)\]>]+$/, '');
}

function extractTargetIdFromExport(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const texts = messages.map((msg) => messageContentText(msg?.content));
  const joined = texts.join('\n\n');
  const patterns = [
    /(?:^|\n)\s*Target\s*ID\s*[:：]\s*(?:\n\s*)?([^\r\n`"'<>]+)/im,
    /target_id["']?\s*[:=]\s*["']?([A-Za-z0-9_.-]+\/[^\s"',}]+)/i,
    /(?:^|\s)((?:nyu|cybench|intercode-ctf|playable|sekai-2026)\/[^\s`"'<>]+)/i,
  ];
  for (const pattern of patterns) {
    const match = joined.match(pattern);
    if (match?.[1]) return cleanTargetId(match[1]);
  }
  return '';
}

function exportHasFinalAnswer(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  return messages.some((msg) => messageContentText(msg?.content).includes('<FINAL_ANSWER>'));
}

function inferCtfFieldStatus(target, payload) {
  const current = String(target?.status || 'untested');
  if (current === 'done' || current === 'failed') return current;
  return exportHasFinalAnswer(payload) ? 'done' : current;
}

async function loadCtfFieldTarget(targetId) {
  const data = await ctfFieldApi(`/targets?q=${encodeURIComponent(targetId)}`);
  const targets = Array.isArray(data?.targets) ? data.targets : [];
  const exact = targets.find((target) => {
    const id = String(target?.target_id || target?.id || '');
    return id === targetId;
  });
  if (exact) return exact;
  if (targets.length === 1) return targets[0];
  throw new Error(`CTF Field target not found: ${targetId}`);
}

function formatCtfFieldProcessNote(payload, targetId) {
  const session = payload?.session || {};
  const sessionId = payload?.sessionId || session.id || '';
  const savedAt = new Date().toLocaleString();
  const trace = formatSessionExportMarkdown(payload).trim();
  return [
    `## Agent visible trace`,
    '',
    `- Target ID: ${targetId}`,
    `- Agent session: ${sessionId}`,
    `- Agent title: ${session.title || ''}`,
    `- Saved at: ${savedAt}`,
    '',
    '> This section is generated from visible Agent messages, tool calls, tool results, and runtime logs.',
    '',
    trace,
  ].join('\n');
}

function appendProcessNote(existing, addition) {
  const current = String(existing || '').trim();
  const next = String(addition || '').trim();
  if (!current) return next;
  return `${current}\n\n---\n\n${next}`;
}

async function saveSessionToCtfField(sessId) {
  const sess = state.sessions.get(sessId);
  if (!sess) return;
  const sessionId = sess.bridgeSessionId || sess.id;
  const payload = await bridgeApi.rpc('session/export', { sessionId });
  if (payload?.error) throw new Error(payload.error.message || payload.error);
  const guessedTargetId = extractTargetIdFromExport(payload);
  const targetId = await promptCtfFieldTarget(guessedTargetId);
  if (!targetId) return;
  const target = await loadCtfFieldTarget(targetId);
  const processNote = appendProcessNote(
    target.process_note || target.process_notes || '',
    formatCtfFieldProcessNote(payload, targetId),
  );
  const record = {
    target_id: targetId,
    status: inferCtfFieldStatus(target, payload),
    failure_reason: target.failure_reason || target.reason || '',
    process_note: processNote,
    target_url: target.target_url || target.url || '',
    assets_path: target.assets_path || target.assets || '',
    run_id: target.run_id || '',
  };
  await ctfFieldApi('/record', { method: 'POST', body: JSON.stringify(record) });
  addDiagnostic('info', 'Saved Agent conversation to CTF Field', { sessionId, targetId, apiBase: ctfFieldApiBase() });
  showSystem(`已保存当前对话到 CTF Field：${targetId}`);
}

function renderSessionRunLog(payload, sess) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  if (!events.length) return '暂无运行日志。';
  return events.map((event) => {
    const stamp = formatEventTime(event.ts) || '未知时间';
    const status = event.status ? ` [${event.status}]` : '';
    const detail = event.detail ? `\n  ${event.detail}` : '';
    return `${stamp} ${event.event || 'event'}${status}${detail}`;
  }).join('\n');
}

async function openSessionRunLog(sessId) {
  const sess = state.sessions.get(sessId);
  if (!sess) return;
  const sessionId = sess.bridgeSessionId || sess.id;
  const payload = await bridgeApi.rpc('session/runtime/log', { sessionId });
  if (payload?.error) throw new Error(payload.error.message || payload.error);
  if (sessionLogSubtitleEl) sessionLogSubtitleEl.textContent = sess.title || sessionId;
  if (sessionLogContentEl) sessionLogContentEl.textContent = renderSessionRunLog(payload, sess);
  if (!sessionLogPanel) return;
  sessionLogPanel.classList.remove('hidden');
  sessionLogPanel.setAttribute('aria-hidden', 'false');
  document.body.classList.add('session-log-open');
}

async function openActiveSessionTrajectory() {
  const sess = state.sessions.get(state.activeId);
  if (!sess) {
    showError('当前没有可查看的会话。');
    return;
  }
  const viewer = window.SecHeurTrajectoryViewer;
  if (!viewer?.open) {
    showError('轨迹查看器没有加载。');
    return;
  }
  try {
    const sessionId = sess.bridgeSessionId || await ensureBridgeSession(sess);
    await viewer.open({ sessionId, title: sess.title || sessionId });
  } catch (err) {
    showError('打开会话轨迹失败：' + (err.message || err));
  }
}

function closeSessionRunLog() {
  if (!sessionLogPanel) return;
  sessionLogPanel.classList.add('hidden');
  sessionLogPanel.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('session-log-open');
}

function cleanupClosedSessionState(id) {
  const runtime = state.runtimeBySessionId.get(id);
  if (runtime?.conversationToolSyncTimer) clearTimeout(runtime.conversationToolSyncTimer);
  state.runtimeBySessionId.delete(id);
  _domCache.delete(id);
  if (state._prevRenderedId === id) state._prevRenderedId = null;
}

function closeSession(id) {
  if (state.sessions.size <= 1) return; // Don't close the last tab
  // Notify bridge to delete this session
  const sess = state.sessions.get(id);
  if (state.activeId === id) globalThis.SecHeurTrajectoryViewer?.close?.();
  if (sess && sess.bridgeSessionId) {
    bridgeApi.rpc('session/delete', { sessionId: sess.bridgeSessionId }).catch(() => {});
  }
  const keys = [...state.sessions.keys()];
  const idx = keys.indexOf(id);
  rememberClosedSession(sess, id);
  state.sessions.delete(id);
  forgetSessionPosition(sess);
  forgetSessionPosition(id);
  persistSessionOrder();
  cleanupClosedSessionState(id);
  if (state.activeId === id) {
    // Switch to adjacent tab (prefer right, fallback left)
    const newIdx = Math.min(idx, keys.length - 2);
    const remaining = [...state.sessions.keys()];
    state.activeId = null;
    setActiveSession(remaining[Math.max(0, Math.min(newIdx, remaining.length - 1))]);
  } else {
    renderSessionList();
  }
}

async function newSession() {
  if (state.planningSelectionSaving) return;
  if (!state.bridgeReady) {
    showError('Bridge 还没有就绪，请稍等。');
    return;
  }
  const previousSess = state.sessions.get(state.activeId) || null;
  const selectionVersion = ++state.sessionSelectionVersion;
  // Don't mark previousSess as busy - it's not doing anything
  // Just show status text without changing any tab dot
  const statusEl = $('status');
  if (statusEl) statusEl.textContent = '正在创建会话…';
  let createdSess = null;
  try {
    const cwd = await getCwd();
    const config = { ...getActiveConfig() };
    const res = await bridgeApi.rpc('session/new', { cwd, mcp_servers: [], ...sessionConfigPayload(config) });
    if (res.error) throw new Error(typeof res.error === 'string' ? res.error : (res.error.message || JSON.stringify(res.error)));
    const bridgeSessionId = res.sessionId;
    createdSess = upsertLocalSessionForBridgeSession({ ...(res.session || {}), id: bridgeSessionId, title: res.session?.title || 'New chat', cwd }, 'New chat', config);
    if (selectionVersion === state.sessionSelectionVersion) setActiveSession(createdSess.id);
    if (createdSess.config.mcpAutoRefresh && isActiveSession(createdSess)) {
      window.setTimeout(() => {
        if (!isActiveSession(createdSess)) return;
        sendPrompt('请调用 mcp_refresh，刷新并列出当前 MCP 工具。', []).catch((err) => addDiagnostic('warn', 'MCP auto refresh failed', err));
      }, 250);
    }
  } catch (e) {
    showError('创建会话失败：' + e.message);
  } finally {
    setBusy(false, null, createdSess || previousSess);
  }
}

async function getCwd() {
  // Use project root as default cwd
  const status = await bridgeApi.checkStatus();
  return projectRootFromPayload(status);
}

// ─── Messages rendering ──────────────────────────────────────────────────
// DOM cache: sessionId -> { fragment, scrollTop }
const _domCache = new Map();

function renderMessages() {
  const sess = state.sessions.get(state.activeId);
  const runtime = sess ? getSessionRuntime(sess) : null;

  // Save current DOM + scroll to cache for previous session
  if (state._prevRenderedId && state._prevRenderedId !== state.activeId) {
    const frag = document.createDocumentFragment();
    while (messagesEl.firstChild) frag.appendChild(messagesEl.firstChild);
    _domCache.set(state._prevRenderedId, {
      fragment: frag,
      scrollTop: runtime ? (state.runtimeBySessionId.get(state._prevRenderedId)?.scrollPos ?? 0) : 0,
    });
  }

  if (runtime) {
    runtime.currentTurnEl = null;
    runtime.lastMessageType = null;
  }

  const hasSavedMessages = !!sess && sess.messages.length > 0;
  const hasDraft = !!runtime?.assistantDraft && !runtime.assistantDraft.finalized;
  if (!sess || (!hasSavedMessages && !hasDraft)) {
    messagesEl.innerHTML = '';
    messagesEl.classList.add('empty');
    messagesEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">欢迎</div>
        <div class="empty-sub">今天想构建什么？</div>
      </div>`;
    if (benchmarkEntryPanelTemplate) messagesEl.querySelector('.empty-state').appendChild(benchmarkEntryPanelTemplate.cloneNode(true));
    state._prevRenderedId = state.activeId;
    hideNewContentButton();
    renderGoalPlan();
    return;
  }

  messagesEl.classList.remove('empty');

  // Try to restore from cache
  const cached = _domCache.get(state.activeId);
  if (cached) {
    messagesEl.innerHTML = '';
    messagesEl.appendChild(cached.fragment);
    _domCache.delete(state.activeId);
    // If there's a live draft, the cached DOM is stale — re-render the draft portion
    if (hasDraft) {
      // Remove the stale assistant wrap (last unfinalized msg-assistant element)
      const last = messagesEl.lastElementChild;
      if (last?.classList?.contains('msg-assistant') && last.dataset.finalized !== '1') {
        last.remove();
      }
      renderAssistantDraft(sess, runtime.assistantDraft);
    }
    messagesEl.scrollTop = cached.scrollTop;
  } else {
    messagesEl.innerHTML = '';
    for (const m of sess.messages) renderMessage(m, false);
    if (hasDraft) renderAssistantDraft(sess, runtime.assistantDraft);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  state._prevRenderedId = state.activeId;
  hideNewContentButton();
  renderGoalPlan();
  renderBlackboardGraph();
  if (runtime?.conversationToolRecords?.size) {
    reconcileConversationToolRecords(sess, [...runtime.conversationToolRecords.values()]);
  }
}

function prepareMessagesForContent() {
  if (messagesEl.classList.contains('empty')) messagesEl.innerHTML = '';
  messagesEl.classList.remove('empty');
}

function permissionDecisionLabel(decision) {
  return {
    allow_once: '已允许本次',
    allow_session: '本会话已允许',
    deny: '已拒绝'
  }[decision] || '已处理';
}

function renderPermissionMessage(msg) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-permission';
  wrap.dataset.requestId = msg.request_id || msg.requestId || '';
  const status = msg.status || 'pending';
  const decision = msg.decision || '';
  const resolved = status === 'resolved' || !!decision;
  const title = msg.title || '需要权限确认';
  const detail = msg.detail || msg.content || '';
  const toolName = msg.tool_name || msg.toolName || 'tool';
  const choices = Array.isArray(msg.choices) ? msg.choices.filter(Boolean) : [];
  const needsTextAnswer = toolName === 'ask_user' && choices.length === 0;
  const statusText = resolved ? (msg.decision_label || permissionDecisionLabel(decision)) : '等待确认';
  const actionsHtml = needsTextAnswer
    ? `<div class="input-row">
        <input class="permission-answer-input" type="text" size="40" value="${escapeHtml(msg.answer || '')}" placeholder="输入回答" aria-label="回答 Agent 的问题" ${resolved ? 'disabled' : ''}>
        <button type="button" class="btn permission-action primary" data-decision="answer" ${resolved ? 'disabled' : 'disabled'}>提交</button>
      </div>`
    : choices.length
      ? choices.map((choice) => (
      `<button type="button" class="btn permission-action primary" data-decision="answer" data-answer="${escapeHtml(choice)}" ${resolved ? 'disabled' : ''}>${escapeHtml(choice)}</button>`
      )).join('')
      : `
        <button type="button" class="btn permission-action primary" data-decision="allow_once" ${resolved ? 'disabled' : ''}>允许本次</button>
        <button type="button" class="btn permission-action" data-decision="allow_session" ${resolved ? 'disabled' : ''}>本会话允许</button>
        <button type="button" class="btn permission-action danger" data-decision="deny" ${resolved ? 'disabled' : ''}>拒绝</button>
      `;
  wrap.innerHTML = `
    <div class="permission-card ${resolved ? 'resolved' : ''}">
      <div class="permission-card-head">
        <span class="permission-kicker">权限申请</span>
        <span class="permission-status">${escapeHtml(statusText)}</span>
      </div>
      <div class="permission-title">${escapeHtml(title)}</div>
      <div class="permission-tool">${escapeHtml(toolName)}</div>
      ${detail ? `<pre class="permission-detail">${escapeHtml(detail)}</pre>` : ''}
      <div class="permission-actions${needsTextAnswer ? ' form-row' : ''}">
        ${actionsHtml}
      </div>
    </div>`;
  if (!resolved) {
    if (needsTextAnswer) {
      const input = wrap.querySelector('.permission-answer-input');
      const submit = wrap.querySelector('.permission-action[data-decision="answer"]');
      const submitAnswer = () => {
        const answer = input?.value?.trim() || '';
        if (!answer) {
          input?.focus();
          return;
        }
        handlePermissionDecision(msg, 'answer', wrap, answer);
      };
      input?.addEventListener('input', () => { submit.disabled = !input.value.trim(); });
      input?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        submitAnswer();
      });
      submit?.addEventListener('click', submitAnswer);
    } else {
      wrap.querySelectorAll('.permission-action').forEach((btn) => {
        btn.addEventListener('click', () => handlePermissionDecision(msg, btn.dataset.decision, wrap, btn.dataset.answer || ''));
      });
    }
  }
  return wrap;
}

async function handlePermissionDecision(msg, decision, wrap, answer = '') {
  const sess = state.sessions.get(state.activeId);
  const requestId = msg.request_id || msg.requestId;
  if (!sess || !requestId || !decision) return;
  wrap.querySelectorAll('.permission-action, .permission-answer-input').forEach((control) => { control.disabled = true; });
  try {
    const result = await bridgeApi.rpc('session/permission', {
      sessionId: sess.bridgeSessionId || sess.id,
      requestId,
      decision,
      answer
    });
    if (result?.error) throw new Error(result.error.message || result.error);
    const updated = result.message || result.result?.message || {
      ...msg,
      status: 'resolved',
      decision,
      answer,
      decision_label: answer || permissionDecisionLabel(decision)
    };
    Object.assign(msg, updated);
    const index = sess.messages.findIndex((item) => (
      (item.request_id || item.requestId) === requestId && item.role === 'permission'
    ));
    if (index >= 0) sess.messages[index] = { ...sess.messages[index], ...updated };
    if (isActiveSession(sess)) {
      const next = renderPermissionMessage({ ...msg, ...updated });
      wrap.replaceWith(next);
    }
  } catch (err) {
    wrap.querySelectorAll('.permission-action, .permission-answer-input').forEach((control) => { control.disabled = false; });
    showError('权限响应失败：' + (err.message || err));
  }
}

function expiredImagePlaceholderHtml(imageInfo = null) {
  const label = imageInfo ? `图片已过期：${attachmentTitle(imageInfo, '图片')}` : '图片已过期';
  const text = imageInfo ? attachmentDisplayName(imageInfo, '已过期') : '已过期';
  return `<span class="user-msg-thumb-placeholder" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2"/>
      <path d="M8 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>
      <path d="m3 17 5-5 4 4 3-3 6 6"/>
      <path d="m4 4 16 16"/>
    </svg>
    <span>${escapeHtml(text)}</span>
  </span>`;
}

function queuedUserBadgeHtml(msg) {
  const status = msg?.queued_status || msg?.queuedStatus || '';
  if (!status) return '';
  const text = status === 'delivered' ? '已交给 Agent' : '等待上一工具调用结束';
  return `<span class="queued-user-badge">${escapeHtml(text)}</span>`;
}

function conversationToolText(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map((part) => {
      if (typeof part === 'string') return part;
      if (part?.type === 'text' && typeof part.text === 'string') return part.text;
      try { return JSON.stringify(part, null, 2); } catch (_) { return String(part); }
    }).filter(Boolean).join('\n');
  }
  try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); }
}

function prettyConversationToolText(value) {
  const text = conversationToolText(value).trim();
  if (!text || !/^[{[]/.test(text)) return text;
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch (_) { return text; }
}

function conversationToolStatus(status, isError = false, resultText = '') {
  const normalized = String(status || '').trim().toLowerCase();
  if (isError || /^(?:error|failed|failure)$/i.test(normalized)) return 'error';
  if (/^(?:cancelled|canceled|stopped|interrupted)$/i.test(normalized)) return 'stopped';
  if (/^(?:pending|queued|starting|started|running|in[_ -]?progress)$/i.test(normalized)) return 'running';
  if (/^(?:complete|completed|success|succeeded|done)$/i.test(normalized)) return 'complete';
  if (resultText) return 'complete';
  return 'running';
}

function conversationToolSummary(record) {
  const resultText = String(record.resultText || '').trim();
  if (record.status === 'error' && resultText) return resultText.split(/\r?\n/)[0].trim();
  const argsText = String(record.requestText || '').trim();
  try {
    const args = JSON.parse(argsText);
    if (args && typeof args === 'object' && !Array.isArray(args)) {
      for (const key of ['description', 'command', 'path', 'file_path', 'query', 'pattern', 'url', 'name']) {
        if (typeof args[key] === 'string' && args[key].trim()) return args[key].trim().split(/\r?\n/)[0];
      }
      const firstValue = Object.values(args).find((value) => typeof value === 'string' && value.trim());
      if (firstValue) return firstValue.trim().split(/\r?\n/)[0];
    }
  } catch (_) {
    // 非 JSON 参数直接使用首行摘要。
  }
  return argsText.split(/\r?\n/).find((line) => line.trim())?.trim() || record.toolCallId || '运行工具';
}

function conversationToolRecordFromCall(call, msg, index) {
  const toolCallId = String(call?.id || call?.toolCallId || `message-${msg?.id || 'current'}-${index}`);
  const requestText = prettyConversationToolText(call?.argsText ?? call?.arguments ?? call?.args ?? call?.input ?? '');
  return {
    toolCallId,
    toolName: String(call?.name || call?.toolName || 'tool'),
    requestText,
    resultText: '',
    status: 'running',
    isError: false,
    timestamp: Number(msg?.ts || msg?.timestamp || Date.now() / 1000),
  };
}

function conversationToolRecordFromResult(msg) {
  const resultText = prettyConversationToolText(msg?.content ?? msg?.result ?? msg?.output ?? '');
  return {
    toolCallId: String(msg?.toolCallId || msg?.tool_call_id || `result-${msg?.id || 'current'}`),
    toolName: String(msg?.toolName || msg?.tool_name || 'tool'),
    requestText: '',
    resultText,
    status: conversationToolStatus(msg?.status, msg?.isError === true, resultText),
    isError: msg?.isError === true,
    timestamp: Number(msg?.ts || msg?.timestamp || Date.now() / 1000),
  };
}

function mergeConversationToolRecord(sess, record) {
  const runtime = getSessionRuntime(sess);
  const current = runtime.conversationToolRecords.get(record.toolCallId) || {};
  const merged = {
    ...current,
    ...record,
    toolCallId: String(record.toolCallId || current.toolCallId || ''),
    toolName: String(record.toolName || current.toolName || 'tool'),
    requestText: record.requestText || current.requestText || '',
    resultText: record.resultText || current.resultText || '',
  };
  const requestedStatus = current.status && current.status !== 'running' && record.status === 'running'
    ? current.status
    : record.status || current.status;
  merged.status = conversationToolStatus(
    requestedStatus,
    record.isError === true || current.isError === true,
    merged.resultText,
  );
  merged.isError = merged.status === 'error';
  runtime.conversationToolRecords.set(merged.toolCallId, merged);
  return merged;
}

function findConversationToolTurn(toolCallId, root = messagesEl) {
  if (!toolCallId || !root) return null;
  return [...root.querySelectorAll('.conversation-tool-turn')]
    .find((turn) => turn.dataset.toolCallId === String(toolCallId)) || null;
}

function appendConversationToolSection(container, label, text, className) {
  if (!text) return;
  const section = document.createElement('section');
  section.className = `conversation-tool-section ${className}`;
  const heading = document.createElement('div');
  heading.className = 'conversation-tool-section-label';
  heading.textContent = label;
  const pre = document.createElement('pre');
  pre.className = 'conversation-tool-section-content';
  const code = document.createElement('code');
  code.textContent = text;
  pre.appendChild(code);
  section.append(heading, pre);
  container.appendChild(section);
}

function updateConversationToolTurn(turn, record) {
  if (!turn || !record) return turn;
  const requestText = prettyConversationToolText(record.requestText);
  const resultText = prettyConversationToolText(record.resultText);
  const status = conversationToolStatus(record.status, record.isError === true, resultText);
  turn.dataset.kind = 'TOOL_CALL';
  turn.dataset.toolCallId = String(record.toolCallId || '');
  turn.dataset.toolName = String(record.toolName || 'tool');
  turn.dataset.toolStatus = status;
  turn.dataset.buf = `Tool: ${record.toolName || 'tool'}\n${requestText}`.trim();
  turn.classList.add('conversation-tool-turn');
  turn.classList.toggle('tool-call-running', status === 'running');
  turn.classList.toggle('tool-call-error', status === 'error');
  turn.classList.toggle('tool-call-stopped', status === 'stopped');
  turn.setAttribute('aria-busy', status === 'running' ? 'true' : 'false');

  const summary = conversationToolSummary({ ...record, requestText, resultText, status });
  const header = turn.querySelector(':scope > .turn-header');
  const summaryEl = header?.querySelector('.turn-summary');
  if (summaryEl) summaryEl.textContent = summary;
  if (header) {
    const statusText = status === 'running' ? '正在运行' : status === 'error' ? '运行失败' : status === 'stopped' ? '已停止' : '已完成';
    header.setAttribute('aria-label', `${record.toolName || 'tool'}：${summary}，${statusText}`);
  }

  const body = turn.querySelector(':scope > .turn-body');
  if (body) {
    const detail = document.createElement('div');
    detail.className = 'conversation-tool-detail';
    appendConversationToolSection(detail, 'Input', requestText, 'conversation-tool-input');
    appendConversationToolSection(
      detail,
      status === 'error' ? 'Error' : 'Output',
      resultText,
      status === 'error' ? 'conversation-tool-error' : 'conversation-tool-output',
    );
    body.replaceChildren(detail);
    injectCopyButtons(body);
  }
  return turn;
}

function buildConversationToolTurn(record, collapsed = true, onCollapseChange = null) {
  const summaryText = `Tool: ${record.toolName || 'tool'}\n${record.requestText || ''}`.trim();
  const turn = buildTurn('TOOL_CALL', summaryText, collapsed, 0, onCollapseChange);
  return updateConversationToolTurn(turn, record);
}

function stampMessageElement(element, msg) {
  if (!element || !msg) return element;
  if (msg.id !== undefined && msg.id !== null) element.dataset.messageId = String(msg.id);
  if (msg.role) element.dataset.messageRole = String(msg.role);
  const timestamp = Number(msg.ts ?? msg.timestamp);
  if (Number.isFinite(timestamp)) element.dataset.messageTimestamp = String(timestamp > 10_000_000_000 ? timestamp / 1000 : timestamp);
  return element;
}

function insertTrajectoryToolTurn(record) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant conversation-tool-message';
  wrap.dataset.finalized = '1';
  wrap.dataset.messageRole = 'tool';
  const timestamp = Number(record.timestamp || 0);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    wrap.dataset.messageTimestamp = String(timestamp > 10_000_000_000 ? timestamp / 1000 : timestamp);
  }
  wrap.appendChild(buildConversationToolTurn(record, true));
  const next = [...messagesEl.children].find((element) => {
    const candidate = Number(element.dataset?.messageTimestamp || 0);
    return timestamp > 0 && candidate > 0 && candidate > (timestamp > 10_000_000_000 ? timestamp / 1000 : timestamp);
  });
  messagesEl.insertBefore(wrap, next || null);
  return wrap;
}

function reconcileConversationToolRecords(sess, records) {
  if (!isActiveSession(sess)) return;
  for (const record of records || []) {
    const merged = mergeConversationToolRecord(sess, {
      toolCallId: String(record.toolCallId || ''),
      toolName: String(record.toolName || 'tool'),
      requestText: prettyConversationToolText(record.requestText || ''),
      resultText: prettyConversationToolText(record.resultText || ''),
      status: record.running ? 'running' : record.isError ? 'error' : 'complete',
      isError: record.isError === true,
      timestamp: Number(record.timestamp || 0),
    });
    if (!merged.toolCallId) continue;
    const turn = findConversationToolTurn(merged.toolCallId);
    if (turn) updateConversationToolTurn(turn, merged);
    else insertTrajectoryToolTurn(merged);
  }
}

async function syncConversationToolsFromTrajectory(sess, serial) {
  const runtime = getSessionRuntime(sess);
  try {
    const sessionId = sess.bridgeSessionId || sess.id;
    const payload = await bridgeApi.rpc('session/runtime/log', { sessionId });
    if (serial !== runtime.conversationToolSyncSerial) return;
    if (payload?.error) throw new Error(payload.error.message || payload.error);
    const records = window.SecHeurTrajectoryViewer?.toolRecords?.(payload) || [];
    reconcileConversationToolRecords(sess, records);
  } catch (error) {
    addDiagnostic('warn', '同步对话工具记录失败', error);
  }
}

function scheduleConversationToolSync(sess, delay = 80) {
  if (!sess?.bridgeSessionId && !sess?.id) return;
  const runtime = getSessionRuntime(sess);
  window.clearTimeout(runtime.conversationToolSyncTimer);
  const serial = ++runtime.conversationToolSyncSerial;
  runtime.conversationToolSyncTimer = window.setTimeout(() => {
    runtime.conversationToolSyncTimer = 0;
    syncConversationToolsFromTrajectory(sess, serial);
  }, delay);
}

function renderMessage(msg, append = true, forceScroll = false) {
  const shouldScroll = append && (forceScroll || isNearBottom());
  prepareMessagesForContent();

  if (msg.role === 'user') {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-user';
    stampMessageElement(wrap, msg);
    let imagesHtml = '';
    const ids = msg.image_ids || [];
    const imageAttachments = Array.isArray(msg.image_attachments) ? msg.image_attachments : [];
    if (ids.length > 0) {
      imagesHtml = '<div class="user-images">' + ids.map(id => {
        const dataUrl = sessionStorage.getItem('img:' + id);
        const imageInfo = imageAttachments.find((item) => item.id === id);
        if (dataUrl) {
          const imageTitle = attachmentTitle(imageInfo || { id, name: '图片' }, '图片');
          return `<img src="${dataUrl}" class="user-msg-thumb" alt="${escapeHtml(imageTitle)}" title="${escapeHtml(imageTitle)}" />`;
        }
        return expiredImagePlaceholderHtml(imageInfo);
      }).join('') + '</div>';
    }
    let filesHtml = '';
    const files = Array.isArray(msg.file_attachments) ? msg.file_attachments : [];
    if (files.length > 0) {
      filesHtml = '<div class="user-files">' + files.map(file => (
        `<span class="user-file-chip" title="${escapeHtml(attachmentTitle(file, '文件'))}" aria-label="${escapeHtml(`已发送文件：${attachmentTitle(file, '文件')}`)}">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <path d="M14 2v6h6"/>
          </svg>
          <span>${escapeHtml(file.name || '文件')}</span>
        </span>`
      )).join('') + '</div>';
    }
    wrap.innerHTML = `<div class="bubble">${queuedUserBadgeHtml(msg)}${imagesHtml}${filesHtml}${escapeHtml(msg.content || '')}</div>`;
    messagesEl.appendChild(wrap);
    const sess = state.sessions.get(state.activeId);
    const runtime = sess ? getSessionRuntime(sess) : null;
    if (runtime) {
      runtime.currentTurnEl = null; // reset turn grouping on user message
      runtime.lastMessageType = 'user';
    }
  } else if (msg.role === 'system') {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-system';
    stampMessageElement(wrap, msg);
    wrap.textContent = msg.content;
    messagesEl.appendChild(wrap);
  } else if (msg.role === 'error') {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-error';
    stampMessageElement(wrap, msg);
    wrap.textContent = msg.content;
    messagesEl.appendChild(wrap);
    const sess = state.sessions.get(state.activeId);
    const runtime = sess ? getSessionRuntime(sess) : null;
    if (runtime) runtime.currentTurnEl = null;
  } else if (msg.role === 'permission') {
    messagesEl.appendChild(stampMessageElement(renderPermissionMessage(msg), msg));
  } else if (msg.role === 'toolResult' || msg.role === 'tool') {
    const sess = state.sessions.get(state.activeId);
    const record = sess
      ? mergeConversationToolRecord(sess, conversationToolRecordFromResult(msg))
      : conversationToolRecordFromResult(msg);
    const turn = findConversationToolTurn(record.toolCallId);
    if (turn) updateConversationToolTurn(turn, record);
    else insertTrajectoryToolTurn(record);
  } else if (msg.role === 'assistant') {
    // Final full message (when reloading from state)
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-assistant';
    wrap.dataset.finalized = '1';
    stampMessageElement(wrap, msg);
    ensureAssistantTaskElapsed(wrap, msg.taskStartedAt, msg.taskEndedAt);
    const activeSess = state.sessions.get(state.activeId);
    if (Array.isArray(msg.segments)) {
      msg.segments.forEach((seg, index) => {
        const onCollapseChange = (turn) => {
          seg.collapsed = turn.classList.contains('collapsed');
          seg.userExpanded = turn.dataset.userExpanded === '1';
          syncTurnCollapseState(state.sessions.get(state.activeId), turn);
        };
        const toolRecord = seg.toolCallId && activeSess
          ? mergeConversationToolRecord(activeSess, {
              toolCallId: seg.toolCallId,
              toolName: seg.toolName || 'tool',
              requestText: seg.toolArgs || '',
              resultText: seg.toolResult || '',
              status: seg.toolStatus || 'running',
              isError: seg.toolStatus === 'error',
            })
          : null;
        const turn = toolRecord
          ? buildConversationToolTurn(toolRecord, seg.collapsed, onCollapseChange)
          : buildTurn(seg.kind, seg.text, seg.collapsed, nextTurnIndexForWrap(wrap), onCollapseChange);
        if (seg.userExpanded) turn.dataset.userExpanded = '1';
        turn.dataset.segmentIndex = String(index);
        if (msg.id) turn.dataset.messageId = String(msg.id);
        wrap.appendChild(turn);
      });
    } else {
      const cleanContent = (msg.content || '').replace(/\n*`{5}\n*\[Info\] Final response to user\.\n*`{5}\s*$/, '');
      if (cleanContent || !Array.isArray(msg.toolCalls) || msg.toolCalls.length === 0) {
        const body = document.createElement('div');
        body.className = 'assistant-response md';
        updateSessionGoalPlanFromAssistantText(activeSess, cleanContent);
        renderStructuredMarkdownInto(body, stripGoalPlanBlocks(cleanContent), structuredRenderOptionsForSession(activeSess, false));
        injectCopyButtons(body);
        wrap.appendChild(body);
      }
    }
    const renderedToolCallIds = new Set(
      [...wrap.querySelectorAll('.conversation-tool-turn')].map((turn) => turn.dataset.toolCallId).filter(Boolean),
    );
    for (const [index, call] of (Array.isArray(msg.toolCalls) ? msg.toolCalls : []).entries()) {
      const incoming = conversationToolRecordFromCall(call, msg, index);
      if (renderedToolCallIds.has(incoming.toolCallId)) continue;
      const record = activeSess ? mergeConversationToolRecord(activeSess, incoming) : incoming;
      const turn = buildConversationToolTurn(record, true);
      if (msg.id) turn.dataset.messageId = String(msg.id);
      wrap.appendChild(turn);
      renderedToolCallIds.add(record.toolCallId);
    }
    injectCopyButtons(wrap);
    messagesEl.appendChild(wrap);
  }
  if (append) scrollOrNotifyNewContent(shouldScroll);
  if (append) renderBlackboardGraph();
}

function syncTurnCollapseState(sess, turn) {
  if (!sess || !turn) return;
  const collapsed = turn.classList.contains('collapsed');
  const segmentIndex = Number(turn.dataset.segmentIndex);
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) return;
  const runtime = getSessionRuntime(sess);
  const draftSeg = runtime.assistantDraft?.segments?.[segmentIndex];
  if (draftSeg) {
    draftSeg.collapsed = collapsed;
    draftSeg.userExpanded = !collapsed;
  }
  const messageId = Number(turn.dataset.messageId || 0);
  if (messageId) {
    const msg = sess.messages.find((item) => Number(item.id || 0) === messageId && Array.isArray(item.segments));
    if (msg?.segments?.[segmentIndex]) {
      msg.segments[segmentIndex].collapsed = collapsed;
      msg.segments[segmentIndex].userExpanded = !collapsed;
    }
  }
}

function isLlmRunningTurn(kind, text, label) {
  return kind === 'LLM_RUNNING'
    || kind === 'agent_thought_chunk'
    || /LLM Running\s*\(Turn\s+\d+\)/i.test(String(text || label || ''));
}

function isTurnBusy(options, kind, text, label) {
  return !!options?.busy && isLlmRunningTurn(kind, text, label);
}

function turnStatusDotHtml(kind, text, label, busy = false) {
  if (!isLlmRunningTurn(kind, text, label)) return '';
  return `<span class="turn-status-dot llm-running${busy ? ' busy' : ''}" aria-hidden="true"></span>`;
}

function buildTurn(kind, text, collapsed, index, onCollapseChange = null) {
  const turn = document.createElement('div');
  turn.className = 'turn' + (collapsed ? ' collapsed' : '');
  turn.dataset.kind = kind;
  const turnIndex = Number(index || 0);
  const label = turnIndex ? turnHeaderLabel(turnIndex, kind) : kind;
  const summary = turnNarrativeForSegment({ kind, text }) ? '' : summarizeStructuredBlock(kind, text);
  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'turn-header';
  header.innerHTML = `${turnStatusDotHtml(kind, text, label, false)}<span class="turn-caret">▼</span><span class="turn-tag">${escapeHtml(label)}</span><span class="turn-summary">${escapeHtml(summary)}</span>`;
  bindTurnDisclosure(turn, header, onCollapseChange);
  const body = document.createElement('div');
  body.className = 'turn-body md';
  const hasTempSubAgentDetail = renderTempSubAgentDetailInto(body, { kind, text });
  const hasSubAgentDetail = hasTempSubAgentDetail || renderSubAgentDetailInto(body, { kind, text });
  const hasToolDetail = Boolean(parseToolDetails(kind, text));
  if (!hasSubAgentDetail) renderToolDetailInto(body, { kind, text });
  if (!hasToolDetail && !hasSubAgentDetail) {
    const rendered = document.createElement('div');
    rendered.className = 'turn-rendered-md';
    rendered.innerHTML = renderMarkdown(text);
    body.appendChild(rendered);
  }
  turn.appendChild(header);
  turn.appendChild(body);
  syncTurnNarrative(turn, kind, text);
  injectCopyButtons(body);
  return turn;
}

function isNearBottom(threshold = 150) {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
}

function prefersReducedMotion() {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
}

function scrollToBottom(smooth = true) {
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' });
  hideNewContentButton();
}

function showNewContentButton() {
  if (!newContentBtn) return;
  newContentBtn.classList.remove('hidden');
  newContentBtn.setAttribute('aria-hidden', 'false');
  newContentBtn.tabIndex = 0;
}

function hideNewContentButton() {
  if (!newContentBtn) return;
  newContentBtn.classList.add('hidden');
  newContentBtn.setAttribute('aria-hidden', 'true');
  newContentBtn.tabIndex = -1;
}

function scrollOrNotifyNewContent(shouldScroll, smooth = false) {
  if (shouldScroll) scrollToBottom(smooth);
  else showNewContentButton();
}

const STREAM_POLL_FALLBACK_MS = 120;

function wakeSessionPoll(runtime) {
  if (!runtime) return;
  runtime.pollWakeVersion = Number(runtime.pollWakeVersion || 0) + 1;
  const resolver = runtime.pollWakeResolver;
  if (typeof resolver === 'function') {
    runtime.pollWakeResolver = null;
    resolver();
  }
}

function waitForSessionPoll(runtime) {
  if (!runtime) return Promise.resolve();
  if (runtime.pollWakeVersion !== runtime.pollObservedWakeVersion) {
    runtime.pollObservedWakeVersion = runtime.pollWakeVersion;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (runtime.pollWakeResolver === finish) runtime.pollWakeResolver = null;
      if (timer) window.clearTimeout(timer);
      runtime.pollObservedWakeVersion = runtime.pollWakeVersion;
      resolve();
    };
    runtime.pollWakeResolver = finish;
    timer = window.setTimeout(finish, STREAM_POLL_FALLBACK_MS);
  });
}

// ─── Streaming chunks (from ACP bridge notifications) ────────────────────
// ACP sends method='session/update' with params.update.sessionUpdate=
//   agent_message_chunk | agent_thought_chunk | tool_call | tool_call_update | plan | available_commands_update
function handleNotification(msg) {
  if (msg.type === 'worklist-state') {
    renderWorklist(msg);
    return;
  }
  // Handle WS session-state notifications from the bridge backend.
  // These have {type: "session-state", sessionId, state, status, seq, ...}
  // and are used to kick-start polling for sessions that became active
  // (e.g. after page reload, or when a background session starts running).
  if (msg.type === 'session-state') {
    const sess = ensureSessionForBridgeNotification(msg);
    if (!sess) return;
    const runtime = getSessionRuntime(sess);
    if (sess.role === 'solver' && !isActiveSession(sess)) {
      runtime.busy = msg.state === 'running' || msg.status === 'running';
      return;
    }
    // The bridge emits one state event for every runtime update. Wake the
    // HTTP poll immediately so token deltas are not held behind a fixed timer.
    wakeSessionPoll(runtime);
    if (/^tool_execution_(?:start|end)$/i.test(String(msg.event || '')) || msg.event === 'idle') {
      scheduleConversationToolSync(sess);
    }
    if (msg.state === 'queue') {
      runtime.forcePollOnce = true;
      runtime.lastPolledMessageId = 0;
      if (!runtime.polling) pollSessionMessages(sess);
    } else if ((msg.state === 'running' || msg.status === 'running') && !runtime.polling) {
      runtime.busy = true;
      runtime.forcePollOnce = true;
      setBusy(true, '思考中…', sess);
      pollSessionMessages(sess);
    } else if (msg.state === 'idle' || msg.state === 'error' || msg.status === 'idle') {
      // Session finished in background — do a final poll to pick up remaining messages
      if (!runtime.polling && runtime.busy) {
        runtime.forcePollOnce = true;
        pollSessionMessages(sess);
      }
    }
    // Update tab dot regardless
    renderSessionList();
    return;
  }
  if (msg.method !== 'session/update') return;
  const update = msg.params?.update;
  if (!update) return;
  const kind = update.sessionUpdate;
  const bridgeSessionId = msg.params?.sessionId || update.sessionId || update.session?.id;
  const sess = findSessionByBridgeId(bridgeSessionId);
  if (!sess) return;


  if (kind === 'agent_message_chunk') {
    const text = extractText(update.content);
    appendAssistantChunk(sess, text);
  } else if (kind === 'task_started') {
    hideError();
    startTaskTimer(sess);
    setBusy(true, '思考中…', sess);
  } else if (kind === 'task_completed' || kind === 'cancelled') {
    finalizeAssistantReply(sess);
    setBusy(false, null, sess);
    hideError();
  } else if (kind === 'error') {
    finalizeAssistantReply(sess);
    setBusy(false, null, sess);
    const errText = update.message || update.error || 'Bridge 错误';
    sess.messages.push({ role: 'error', content: errText });
    if (isActiveSession(sess)) renderMessage({ role: 'error', content: errText });
    showError(errText);
  } else if (kind === 'agent_thought_chunk') {
    const text = extractText(update.content);
    appendStreamChunk(sess, kind, text);
  } else if (kind === 'tool_call') {
    const toolName = update.title || update.name || update.kind || update.toolCallId || 'tool';
    const args = update.arguments || update.args || update.input || update.content || '';
    appendConversationToolUpdate(sess, {
      toolCallId: String(update.toolCallId || update.id || `${toolName}-${Date.now()}`),
      toolName: String(toolName),
      requestText: prettyConversationToolText(args),
      resultText: '',
      status: 'running',
      isError: false,
      timestamp: Date.now() / 1000,
    });
  } else if (kind === 'tool_call_update') {
    const resultText = prettyConversationToolText(update.result ?? update.output ?? update.content ?? '');
    appendConversationToolUpdate(sess, {
      toolCallId: String(update.toolCallId || update.id || ''),
      toolName: String(update.title || update.name || update.kind || ''),
      requestText: '',
      resultText,
      status: conversationToolStatus(update.status, update.isError === true, resultText),
      isError: update.isError === true || /^(?:error|failed|failure)$/i.test(String(update.status || '')),
      timestamp: Date.now() / 1000,
    });
  } else if (kind === 'plan') {
    const lines = (update.entries || []).map(e =>
      `- [${e.status || 'pending'}] ${e.content || ''}`
    ).join('\n');
    appendTurn(sess, 'plan', lines, false);
  }
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (content.type === 'text') return content.text || '';
  if (Array.isArray(content)) return content.map(extractText).join('');
  return '';
}

function getLiveAssistantWrap(sess) {
  if (!isActiveSession(sess)) return null;
  const last = messagesEl.lastElementChild;
  if (last?.classList?.contains('msg-assistant') && last.dataset.finalized !== '1') return last;
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  const runtime = getSessionRuntime(sess);
  if (runtime.taskStartedAt) {
    wrap.dataset.taskStartedAt = String(runtime.taskStartedAt);
    ensureAssistantTaskElapsed(wrap, runtime.taskStartedAt);
  }
  messagesEl.appendChild(wrap);
  return wrap;
}

function getAssistantDraft(sess) {
  const runtime = getSessionRuntime(sess);
  if (!runtime.assistantDraft || runtime.assistantDraft.finalized) {
    runtime.assistantDraft = {
      text: '',
      segments: [],
      currentSegmentIndex: -1,
      taskStartedAt: runtime.taskStartedAt || 0,
      taskEndedAt: 0,
      finalized: false,
      bridgeMessageId: 0
    };
  }
  if (!runtime.assistantDraft.taskStartedAt && runtime.taskStartedAt) runtime.assistantDraft.taskStartedAt = runtime.taskStartedAt;
  return runtime.assistantDraft;
}

function renderAssistantDraft(sess, draft) {
  if (!isActiveSession(sess) || !draft || draft.finalized) return null;
  const runtime = getSessionRuntime(sess);
  prepareMessagesForContent();
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-assistant';
  if (draft.taskStartedAt) {
    wrap.dataset.taskStartedAt = String(draft.taskStartedAt);
    ensureAssistantTaskElapsed(wrap, draft.taskStartedAt, draft.taskEndedAt);
  }
  if (draft.text) {
    wrap.dataset.buf = draft.text;
    const body = document.createElement('div');
    body.className = 'assistant-response md';
    updateSessionGoalPlanFromAssistantText(sess, draft.text);
    renderStructuredMarkdownInto(body, stripGoalPlanBlocks(draft.text), structuredRenderOptionsForSession(sess, runtime?.busy || !draft.finalized));
    injectCopyButtons(body);
    if (!draft.finalized) body.insertAdjacentHTML('beforeend', '<span class="cursor"></span>');
    wrap.appendChild(body);
  }
  (draft.segments || []).forEach((seg, index) => {
    const onCollapseChange = (turn) => {
      seg.collapsed = turn.classList.contains('collapsed');
      seg.userExpanded = turn.dataset.userExpanded === '1';
      syncTurnCollapseState(sess, turn);
    };
    const toolRecord = seg.toolCallId
      ? mergeConversationToolRecord(sess, {
          toolCallId: seg.toolCallId,
          toolName: seg.toolName || 'tool',
          requestText: seg.toolArgs || '',
          resultText: seg.toolResult || '',
          status: seg.toolStatus || 'running',
          isError: seg.toolStatus === 'error',
        })
      : null;
    const turn = toolRecord
      ? buildConversationToolTurn(toolRecord, seg.collapsed, onCollapseChange)
      : buildTurn(seg.kind, seg.text, seg.collapsed, nextTurnIndexForWrap(wrap), onCollapseChange);
    if (seg.userExpanded) turn.dataset.userExpanded = '1';
    turn.dataset.segmentIndex = String(index);
    if (draft.bridgeMessageId) turn.dataset.messageId = String(draft.bridgeMessageId);
    wrap.appendChild(turn);
  });
  injectCopyButtons(wrap);
  messagesEl.appendChild(wrap);
  return wrap;
}

function renderAssistantDraftInPlace(sess, draft) {
  if (!isActiveSession(sess) || !draft || draft.finalized) return null;
  prepareMessagesForContent();
  const runtime = getSessionRuntime(sess);
  const shouldScroll = isNearBottom();
  updateSessionStage(sess, '正在接收回复', 'agent_message_chunk');
  const wrap = getLiveAssistantWrap(sess);
  if (draft.taskStartedAt || runtime.taskStartedAt) {
    const startedAt = draft.taskStartedAt || runtime.taskStartedAt;
    wrap.dataset.taskStartedAt = String(startedAt);
    ensureAssistantTaskElapsed(wrap, startedAt, draft.taskEndedAt);
  }
  wrap.dataset.buf = draft.text || '';
  let body = wrap.querySelector('.assistant-response');
  if (!body) {
    body = document.createElement('div');
    body.className = 'assistant-response md';
    // Keep plain assistant text before folded/tool turns.
    const firstTurn = wrap.querySelector('.turn');
    if (firstTurn) wrap.insertBefore(body, firstTurn);
    else wrap.appendChild(body);
  }
  updateSessionGoalPlanFromAssistantText(sess, draft.text || '');
  renderStructuredMarkdownInto(body, stripGoalPlanBlocks(draft.text || ''), structuredRenderOptionsForSession(sess, runtime?.busy || !draft.finalized));
  injectCopyButtons(body);
  body.insertAdjacentHTML('beforeend', '<span class="cursor"></span>');
  renderBlackboardGraph();
  scrollOrNotifyNewContent(shouldScroll, false);
  return wrap;
}

function appendAssistantChunk(sess, text) {
  if (!text) return;
  const runtime = getSessionRuntime(sess);
  markAssistantActivity(sess);
  updateSessionStage(sess, '正在接收回复', 'agent_message_chunk');
  const draft = getAssistantDraft(sess);
  draft.text += text;
  draft.currentSegmentIndex = -1;
  runtime.currentTurnEl = null;
  if (!isActiveSession(sess)) return;
  prepareMessagesForContent();
  const shouldScroll = isNearBottom();
  let wrap = getLiveAssistantWrap(sess);
  let body = wrap.querySelector('.assistant-response');
  if (!body) {
    body = document.createElement('div');
    body.className = 'assistant-response md';
    wrap.appendChild(body);
  }
  wrap.dataset.buf = draft.text;
  ensureAssistantTaskElapsed(wrap, draft.taskStartedAt || runtime.taskStartedAt);
  updateSessionGoalPlanFromAssistantText(sess, draft.text);
  renderStructuredMarkdownInto(body, stripGoalPlanBlocks(draft.text), structuredRenderOptionsForSession(sess, runtime?.busy || !draft.finalized));
  body.insertAdjacentHTML('beforeend', '<span class="cursor"></span>');
  renderBlackboardGraph();
  scrollOrNotifyNewContent(shouldScroll, false);
}

function appendStreamChunk(sess, kind, text) {
  if (!text) return;
  // Group consecutive chunks of same kind into one turn (fold_turns style)
  const runtime = getSessionRuntime(sess);
  markAssistantActivity(sess);
  updateSessionStage(sess, executionStageLabel(kind, text), kind);
  const draft = getAssistantDraft(sess);
  let seg = draft.segments[draft.currentSegmentIndex];
  if (!seg || seg.kind !== kind) {
    seg = { kind, text: '', collapsed: false };
    draft.segments.push(seg);
    draft.currentSegmentIndex = draft.segments.length - 1;
    runtime.currentTurnEl = null;
  }
  seg.text += text;
  if (!isActiveSession(sess)) return;
  const shouldScroll = isNearBottom();
  let turn = runtime.currentTurnEl;
  const currentKind = turn?.dataset.kind;
  if (!turn || currentKind !== kind) {
    turn = createStreamingTurn(sess, kind);
    runtime.currentTurnEl = turn;
  }
  turn.dataset.buf = seg.text;
  const body = turn.querySelector('.turn-body');
  const { remaining: cleanText } = stripLeadingMetaTags(seg.text);
  syncTurnNarrative(turn, kind, seg.text);
  // Only render the clean body text (no summary-hint in body)
  body.innerHTML = renderMarkdown(cleanText) + '<span class="cursor"></span>';
  renderBlackboardGraph();
  scrollOrNotifyNewContent(shouldScroll, false);
}

function appendTurn(sess, kind, text, collapsed) {
  markAssistantActivity(sess);
  updateSessionStage(sess, executionStageLabel(kind, text), kind);
  const draft = getAssistantDraft(sess);
  const seg = { kind, text, collapsed: !!collapsed };
  draft.segments.push(seg);
  const segmentIndex = draft.segments.length - 1;
  draft.currentSegmentIndex = -1;
  if (!isActiveSession(sess)) return;
  prepareMessagesForContent();
  const shouldScroll = isNearBottom();
  const wrap = getLiveAssistantWrap(sess);
  const turn = buildTurn(kind, text, collapsed, nextTurnIndexForWrap(wrap), (turn) => {
    seg.collapsed = turn.classList.contains('collapsed');
    seg.userExpanded = turn.dataset.userExpanded === '1';
    syncTurnCollapseState(sess, turn);
  });
  turn.dataset.segmentIndex = String(segmentIndex);
  if (draft.bridgeMessageId) turn.dataset.messageId = String(draft.bridgeMessageId);
  wrap.appendChild(turn);
  renderBlackboardGraph();
  scrollOrNotifyNewContent(shouldScroll, false);
}

function appendConversationToolUpdate(sess, record) {
  if (!record.toolCallId) return;
  markAssistantActivity(sess);
  updateSessionStage(sess, record.status === 'running' ? `正在运行 ${record.toolName || 'tool'}` : `${record.toolName || 'tool'} 已完成`, 'TOOL_CALL');
  const merged = mergeConversationToolRecord(sess, record);
  const draft = getAssistantDraft(sess);
  let segmentIndex = draft.segments.findIndex((segment) => segment.toolCallId === merged.toolCallId);
  if (segmentIndex < 0) {
    draft.segments.push({
      kind: 'TOOL_CALL',
      text: `Tool: ${merged.toolName}\n${merged.requestText}`.trim(),
      collapsed: true,
      toolCallId: merged.toolCallId,
      toolName: merged.toolName,
      toolArgs: merged.requestText,
      toolResult: merged.resultText,
      toolStatus: merged.status,
    });
    segmentIndex = draft.segments.length - 1;
  } else {
    Object.assign(draft.segments[segmentIndex], {
      text: `Tool: ${merged.toolName}\n${merged.requestText}`.trim(),
      toolName: merged.toolName,
      toolArgs: merged.requestText,
      toolResult: merged.resultText,
      toolStatus: merged.status,
    });
  }
  draft.currentSegmentIndex = -1;
  const runtime = getSessionRuntime(sess);
  runtime.currentTurnEl = null;
  if (!isActiveSession(sess)) return;
  prepareMessagesForContent();
  const shouldScroll = isNearBottom();
  const wrap = getLiveAssistantWrap(sess);
  let turn = findConversationToolTurn(merged.toolCallId, wrap);
  if (!turn) {
    const seg = draft.segments[segmentIndex];
    turn = buildConversationToolTurn(merged, seg.collapsed, (changedTurn) => {
      seg.collapsed = changedTurn.classList.contains('collapsed');
      seg.userExpanded = changedTurn.dataset.userExpanded === '1';
      syncTurnCollapseState(sess, changedTurn);
    });
    turn.dataset.segmentIndex = String(segmentIndex);
    if (draft.bridgeMessageId) turn.dataset.messageId = String(draft.bridgeMessageId);
    wrap.appendChild(turn);
  } else {
    updateConversationToolTurn(turn, merged);
  }
  renderBlackboardGraph();
  scrollOrNotifyNewContent(shouldScroll, false);
}

function createStreamingTurn(sess, kind) {
  prepareMessagesForContent();
  const wrap = getLiveAssistantWrap(sess);
  updateSessionStage(sess, executionStageLabel(kind), kind);
  const turn = document.createElement('div');
  turn.className = 'turn';
  turn.dataset.kind = kind;
  const displayKind = kind === 'agent_thought_chunk' ? 'thinking' : 'response';
  const turnIndex = nextTurnIndexForWrap(wrap);
  turn.innerHTML = `
    <button class="turn-header" type="button"><span class="turn-caret">▼</span><span class="turn-tag">${escapeHtml(turnHeaderLabel(turnIndex, displayKind))}</span><span class="turn-summary"></span></button>
    <div class="turn-body md"></div>`;
  const draft = getAssistantDraft(sess);
  if (Number.isInteger(draft.currentSegmentIndex) && draft.currentSegmentIndex >= 0) {
    turn.dataset.segmentIndex = String(draft.currentSegmentIndex);
  }
  if (draft.bridgeMessageId) turn.dataset.messageId = String(draft.bridgeMessageId);
  // thinking turns collapsed by default once complete
  if (kind === 'agent_thought_chunk') turn.dataset.autoCollapse = '1';
  const header = turn.querySelector('.turn-header');
  if (header) {
    const label = turnHeaderLabel(turnIndex, displayKind);
    header.innerHTML = `${turnStatusDotHtml(kind, '', label, true)}<span class="turn-caret">▼</span><span class="turn-tag">${escapeHtml(label)}</span><span class="turn-summary"></span>`;
  }
  bindTurnDisclosure(turn, header, () => syncTurnCollapseState(sess, turn));
  wrap.appendChild(turn);
  return turn;
}

function getCurrentAssistantWrap(sess) {
  if (!isActiveSession(sess)) return null;
  const last = messagesEl.lastElementChild;
  if (last?.classList?.contains('msg-assistant') && last.dataset.finalized !== '1') return last;
  return null;
}

function finalizeStreamingTurn(sess) {
  const runtime = getSessionRuntime(sess);
  const wrap = getCurrentAssistantWrap(sess);
  const liveAssistant = wrap?.querySelector('.assistant-response');
  if (liveAssistant) {
    updateSessionGoalPlanFromAssistantText(sess, wrap.dataset.buf || '');
    renderStructuredMarkdownInto(liveAssistant, stripGoalPlanBlocks(wrap.dataset.buf || ''), structuredRenderOptionsForSession(sess, false));
    injectCopyButtons(liveAssistant);
  }
  if (runtime.assistantDraft?.segments?.length) {
    for (const seg of runtime.assistantDraft.segments) {
      if (seg.kind === 'agent_thought_chunk' && !seg.userExpanded) seg.collapsed = true;
    }
  }
  if (!runtime.currentTurnEl) return;
  const t = runtime.currentTurnEl;
  const body = t.querySelector('.turn-body');
  // Remove cursor and strip summary/think tags from the expandable body.
  if (body) {
    const { summary: extractedSummary, remaining: cleanBuf } = stripLeadingMetaTags(t.dataset.buf || '');
    body.innerHTML = renderMarkdown(cleanBuf);
    const kind = t.dataset.kind || 'response';
    const narrative = turnNarrativeForSegment({ kind, text: t.dataset.buf || '' });
    syncTurnNarrative(t, kind, t.dataset.buf || '');
    const summaryEl = t.querySelector('.turn-summary');
    if (summaryEl) {
      summaryEl.textContent = narrative ? '' : extractedSummary || summarizeStructuredBlock(kind, cleanBuf);
    }
  }
  if (t.dataset.autoCollapse === '1' && t.dataset.userExpanded !== '1') t.classList.add('collapsed');
  syncTurnDisclosureState(t, t.querySelector('.turn-header'));
  const idx = runtime.assistantDraft?.currentSegmentIndex;
  if (Number.isInteger(idx) && runtime.assistantDraft?.segments?.[idx]) {
    runtime.assistantDraft.segments[idx].collapsed = t.classList.contains('collapsed');
  }
  runtime.currentTurnEl = null;
}

function finalizeAssistantReply(sess) {
  const endedAt = getNowMs();
  finalizeStreamingTurn(sess);
  // Remove any residual blinking cursors (e.g. after RPC timeout)
  messagesEl.querySelectorAll('.cursor').forEach(el => el.remove());
  const runtime = getSessionRuntime(sess);
  const draft = runtime.assistantDraft;
  const wrap = getCurrentAssistantWrap(sess);
  if (draft && sess && !draft.finalized) {
    draft.finalized = true;
    draft.taskEndedAt = endedAt;
    // Strip trailing [Info] Final response to user. marker (wrapped in 5 backticks)
    if (draft.text) {
      draft.text = draft.text.replace(/\n*`{5}\n*\[Info\] Final response to user\.\n*`{5}\s*$/, '');
    }
    if (draft.segments?.length) {
      const last = draft.segments[draft.segments.length - 1];
      if (last && last.text) {
        last.text = last.text.replace(/\n*`{5}\n*\[Info\] Final response to user\.\n*`{5}\s*$/, '');
      }
    }
    const msg = { role: 'assistant', finalized: true, taskEndedAt: endedAt };
    if (draft.bridgeMessageId) msg.id = Number(draft.bridgeMessageId);
    if (draft.taskStartedAt) msg.taskStartedAt = Number(draft.taskStartedAt);
    if (draft.text) msg.content = draft.text;
    if (draft.segments?.length) msg.segments = draft.segments.map((seg) => ({
      kind: seg.kind,
      text: seg.text || '',
      collapsed: !!seg.collapsed,
      userExpanded: !!seg.userExpanded,
      ...(seg.toolCallId ? {
        toolCallId: seg.toolCallId,
        toolName: seg.toolName || 'tool',
        toolArgs: seg.toolArgs || '',
        toolResult: seg.toolResult || '',
        toolStatus: seg.toolStatus || 'running',
      } : {}),
    }));
    if (msg.content || msg.segments?.length) sess.messages.push(msg);
    runtime.assistantDraft = null;
  }
  if (wrap) {
    wrap.dataset.finalized = '1';
    wrap.dataset.taskEndedAt = String(endedAt);
    ensureAssistantTaskElapsed(wrap, wrap.dataset.taskStartedAt || runtime.taskStartedAt || draft?.taskStartedAt, endedAt);
    renderMessages();
  } else if (!isActiveSession(sess)) {
    // Session finished in background — its DOM cache is stale, discard it
    // so that switching to it will do a full re-render from sess.messages
    _domCache.delete(sess.id);
  }
  stopTaskTimer(sess);
  clearSessionStage(sess);
  renderSessionList();
}

// ─── Sending prompts ─────────────────────────────────────────────────────
function normalizeBridgeMessage(msg) {
  return {
    ...msg,
    id: Number(msg.id || 0),
    role: msg.role || 'system',
    content: msg.content || '',
    image_ids: msg.image_ids || [],
    queued_status: msg.queued_status || msg.queuedStatus || ''
  };
}

function findMessageIndexByBridgeId(sess, msg) {
  if (!sess || !msg) return -1;
  const existingById = sess.messages.findIndex((item) => Number(item.id || 0) === msg.id && item.role === msg.role);
  if (existingById >= 0) return existingById;
  if (msg.role === 'user') {
    return sess.messages.findIndex((item) => (
      !item.id
      && item.role === 'user'
      && (item.content || '') === (msg.content || '')
      && (item.queued_status || '') === (msg.queued_status || '')
    ));
  }
  return -1;
}

function upsertPolledMessage(sess, raw, { partial = false } = {}) {
  if (!sess || !raw) return;
  const msg = normalizeBridgeMessage(raw);
  if (!msg.id) return;
  const runtime = getSessionRuntime(sess);
  if (!runtime.seenBridgeMessageIds) runtime.seenBridgeMessageIds = new Set();

  if (partial && msg.role === 'assistant') {
    const existingIndex = findMessageIndexByBridgeId(sess, msg);
    if (existingIndex >= 0) {
      const existingChanged = (sess.messages[existingIndex].content || '') !== (msg.content || '');
      if (existingChanged) {
        markAssistantActivity(sess);
        updateSessionStage(sess, '正在接收回复', 'agent_message_chunk');
      }
      sess.messages[existingIndex] = { ...sess.messages[existingIndex], ...msg, partial: true };
      runtime.lastPolledMessageId = Math.max(Number(runtime.lastPolledMessageId || 0), msg.id - 1);
      if (isActiveSession(sess)) renderMessages();
      return;
    }
    const draft = getAssistantDraft(sess);
    const changed = draft.bridgeMessageId !== msg.id || draft.text !== (msg.content || '');
    draft.bridgeMessageId = msg.id;
    draft.text = msg.content || '';
    draft.currentSegmentIndex = -1;
    draft.finalized = false;
    if (changed) {
      markAssistantActivity(sess);
      updateSessionStage(sess, '正在接收回复', 'agent_message_chunk');
    }
    // Polling partial updates used to call renderMessages(), which rebuilt the
    // whole message list every 500ms. That destroys user fold/collapse DOM
    // state and can make the live answer appear to jump/duplicate. Update only
    // the live assistant draft in-place; final messages are still reconciled by
    // id in the non-partial branch below.
    if (changed && isActiveSession(sess)) renderAssistantDraftInPlace(sess, draft);
    return;
  }

  const existingIndex = findMessageIndexByBridgeId(sess, msg);
  if (existingIndex >= 0) {
    if (msg.role === 'assistant' || msg.role === 'error') markAssistantActivity(sess);
    sess.messages[existingIndex] = { ...sess.messages[existingIndex], ...msg };
    runtime.lastPolledMessageId = Math.max(Number(runtime.lastPolledMessageId || 0), msg.id);
    const draft = runtime.assistantDraft;
    if (msg.role === 'assistant' && draft && Number(draft.bridgeMessageId || 0) === msg.id) {
      runtime.assistantDraft = null;
    }
    if (isActiveSession(sess)) renderMessages();
    return;
  }
  if (runtime.seenBridgeMessageIds.has(msg.id)) return;
  runtime.seenBridgeMessageIds.add(msg.id);
  runtime.lastPolledMessageId = Math.max(Number(runtime.lastPolledMessageId || 0), msg.id);

  const draft = runtime.assistantDraft;
  if (msg.role === 'assistant' && draft && !draft.finalized && Number(draft.bridgeMessageId || 0) === msg.id) {
    draft.text = msg.content || draft.text || '';
    finalizeAssistantReply(sess);
    return;
  }
  sess.messages.push(msg);
  if (msg.role === 'assistant' || msg.role === 'error') markAssistantActivity(sess);
  if (isActiveSession(sess)) renderMessage(msg);
}

async function pollSessionMessages(sess) {
  if (!sess) return;
  if (sess.role === 'solver' && !isActiveSession(sess)) return;
  const runtime = getSessionRuntime(sess);
  if (runtime.messagesLoading) {
    // hydrate 完成前禁止增量请求，避免同一会话同时重建历史和追加消息。
    const pendingHydration = runtime.messagesHydrationPromise;
    if (pendingHydration && !runtime.messagesHydrationPollQueued) {
      runtime.messagesHydrationPollQueued = true;
      void pendingHydration.then(() => {
        runtime.messagesHydrationPollQueued = false;
        if (runtime.forcePollOnce || runtime.busy) pollSessionMessages(sess);
      }, () => {
        runtime.messagesHydrationPollQueued = false;
      });
    }
    return;
  }
  if (runtime.polling) return;
  runtime.polling = true;
  runtime.pollObservedWakeVersion = runtime.pollWakeVersion;
  try {
    while (runtime.busy || runtime.forcePollOnce) {
      runtime.forcePollOnce = false;
      const res = await bridgeApi.pollSession(sess.bridgeSessionId || sess.id, runtime.lastPolledMessageId || 0);
      if (res?.error) throw new Error(res.error.message || res.error);
      const result = res.result || res;
      if (result.blackboardGraph) sess.blackboardGraph = result.blackboardGraph;
      runtime.messagesLoaded = true;
      for (const msg of (result.messages || [])) upsertPolledMessage(sess, msg, { partial: false });
      if (result.partial) upsertPolledMessage(sess, result.partial, { partial: true });
      const busy = result.status === 'running' || !!result.partial;
      const stage = getSessionRuntime(sess).currentStageText || '正在等待模型响应…';
      setBusy(busy, busy ? stage : null, sess);
      if (busy) maybeWarnModelStall(sess, result);
      if (!busy) {
        finalizeAssistantReply(sess);
        break;
      }
      await waitForSessionPoll(runtime);
    }
  } catch (e) {
    if (isBridgeSessionNotFoundError(e)) {
      clearStaleBridgeSession(sess, e);
      const errText = '后端会话已失效，已解除当前等待状态，请重新发送。';
      sess.messages.push({ role: 'error', content: errText, ts: Date.now() / 1000 });
      if (isActiveSession(sess)) renderMessage(sess.messages[sess.messages.length - 1]);
      showError(errText, null, null, { persist: true });
      setBusy(false, null, sess);
      return;
    }
    addDiagnostic('error', 'Polling failed', e);
    const errText = '轮询失败：' + (e.message || e);
    sess.messages.push({ role: 'error', content: errText, ts: Date.now() / 1000 });
    if (isActiveSession(sess)) renderMessage(sess.messages[sess.messages.length - 1]);
    showError(errText, null, null, { persist: true });
    setBusy(false, null, sess);
  } finally {
    runtime.pollWakeResolver = null;
    runtime.polling = false;
  }
}

function sessionPromptPayload(sess, text, images = [], files = [], wasBusy = false, displayText = text) {
  return {
    prompt: text,
    displayPrompt: displayText,
    images: images.map(img => ({ id: img.id, dataUrl: img.dataUrl })),
    files: files.map(file => ({
      id: file.id,
      name: file.name,
      type: file.type || '',
      size: file.size || 0,
      dataUrl: file.dataUrl,
    })),
    llmNo: sess.config.llmNo,
    queue: wasBusy,
    force: false,
    webVerbsEnabled: isWebVerbsEnabled(),
  };
}

function isHeuristicLearningEnabled() {
  return !!composerHeuristicLearningToggle?.checked;
}

function initHeuristicLearningToggle() {
  if (!composerHeuristicLearningToggle) return;
  try {
    composerHeuristicLearningToggle.checked = localStorage.getItem(HEURISTIC_LEARNING_STORAGE_KEY) === 'true';
  } catch (err) {
    addDiagnostic('warn', '读取启发式学习开关失败', err);
  }
  composerHeuristicLearningToggle.addEventListener('change', () => {
    try {
      localStorage.setItem(HEURISTIC_LEARNING_STORAGE_KEY, composerHeuristicLearningToggle.checked ? 'true' : 'false');
    } catch (err) {
      addDiagnostic('warn', '保存启发式学习开关失败', err);
    }
    renderBlackboardGraph();
  });
}

function isWebVerbsEnabled() {
  return !!composerWebVerbsToggle?.checked;
}

function initWebVerbsToggle() {
  if (!composerWebVerbsToggle) return;
  try {
    composerWebVerbsToggle.checked = localStorage.getItem(WEB_VERBS_STORAGE_KEY) === 'true';
  } catch (err) {
    addDiagnostic('warn', '读取 Web Verb 开关失败', err);
  }
  composerWebVerbsToggle.addEventListener('change', () => {
    try {
      localStorage.setItem(WEB_VERBS_STORAGE_KEY, composerWebVerbsToggle.checked ? 'true' : 'false');
    } catch (err) {
      addDiagnostic('warn', '保存 Web Verb 开关失败', err);
    }
    renderBlackboardGraph();
  });
}

function applyHeuristicLearningPrompt(text) {
  const raw = String(text || '').trim();
  if (!isHeuristicLearningEnabled()) return text;
  if (!raw) return text;
  if (raw.startsWith('/')) return text;
  return `${HEURISTIC_LEARNING_PROMPT_PREFIX}\n\n${raw}`;
}

async function submitPromptWithSessionRecovery(sess, payload) {
  let sessionId = await ensureBridgeSession(sess);
  try {
    return await bridgeApi.rpc('session/prompt', { sessionId, ...payload });
  } catch (err) {
    if (!isBridgeSessionNotFoundError(err)) throw err;
    clearStaleBridgeSession(sess, err, sessionId);
    sessionId = await ensureBridgeSession(sess, { forceNew: true });
    addDiagnostic('warn', '后端会话丢失，已重建会话并重发当前消息', { sessionId });
    return bridgeApi.rpc('session/prompt', { sessionId, ...payload });
  }
}

async function sendPrompt(text, images = [], files = [], targetSession = null, options = {}) {
  if (!state.bridgeReady) {
    showError('Bridge 还没有就绪。');
    return;
  }
  ensureChatView();
  if (!targetSession && !state.activeId) {
    await newSession();
    if (!state.activeId) return;
  }
  const sess = targetSession || state.sessions.get(state.activeId);
  if (!sess) return;
  const runtime = getSessionRuntime(sess);
  const wasBusy = !!runtime.busy;
  const displayText = options.displayText ?? text;
  const backendText = options.backendText ?? displayText;

  // Store images in sessionStorage and collect ids
  const imageIds = images.map(img => {
    try { sessionStorage.setItem('img:' + img.id, img.dataUrl); } catch(e) { /* quota */ }
    return img.id;
  });
  const imageAttachments = images.map(img => ({
    id: img.id,
    name: img.name || '图片',
    size: img.size || 0,
  }));
  const fileAttachments = files.map(file => ({
    id: file.id,
    name: file.name,
    type: file.type || '',
    size: file.size || 0,
  }));

  const legacyVisibleText = text || (fileAttachments.length || imageAttachments.length ? '已上传附件' : '');
  const localUserMsg = { role: 'user', content: displayText || (legacyVisibleText !== text ? legacyVisibleText : ''), image_ids: imageIds, image_attachments: imageAttachments, file_attachments: fileAttachments, queued_status: wasBusy ? 'queued' : '' };
  const previousTitle = sess.title;
  const previousUntitled = sess.untitled;
  sess.messages.push(localUserMsg);
  renderSessionList();
  if (isActiveSession(sess)) renderMessage(localUserMsg, true, true);
  if (!wasBusy) startTaskTimer(sess);
  if (sess.untitled || isUntitledSessionTitle(sess.title)) {
    const titleSource = String(displayText || '').trim() || fileAttachments.map(file => file.name).filter(Boolean).join(', ') || '附件';
    sess.title = titleSource.slice(0, 40) + (titleSource.length > 40 ? '…' : '');
    sess.untitled = false;
    if (sessionTitleEl && isActiveSession(sess)) sessionTitleEl.textContent = sess.title;
    renderSessionList();
  }

  if (!wasBusy) {
    setBusy(true, '思考中…', sess);
    updateSessionStage(sess, '正在发送请求…', 'request');
  } else if (isActiveSession(sess)) {
    flashComposerNotice('已排队：等待上一工具调用结束后交给 Agent。');
  }
  try {
    const res = await submitPromptWithSessionRecovery(sess, sessionPromptPayload(sess, backendText, images, files, wasBusy, displayText));
    if (res?.error) throw new Error(res.error.message || res.error);
    const acceptedUserId = Number(res.userMessageId || res.result?.userMessageId || 0);
    if (acceptedUserId) {
      localUserMsg.id = acceptedUserId;
    }
    if (res?.queued) {
      localUserMsg.queued_status = 'queued';
      if (acceptedUserId) {
        runtime.lastPolledMessageId = Math.min(
          Number(runtime.lastPolledMessageId || 0),
          Math.max(acceptedUserId - 1, 0)
        );
      }
      flashComposerNotice(`已排队：等待上一工具调用结束后发送${res.queuedCount > 1 ? `（${res.queuedCount} 条）` : ''}。`);
      renderMessages();
      return;
    }
    if (acceptedUserId) {
      if (!runtime.seenBridgeMessageIds) runtime.seenBridgeMessageIds = new Set();
      runtime.seenBridgeMessageIds.add(acceptedUserId);
      runtime.lastPolledMessageId = Math.max(Number(runtime.lastPolledMessageId || 0), acceptedUserId);
    }
    runtime.forcePollOnce = true;
    updateSessionStage(sess, '正在等待模型响应…', 'LLM_RUNNING');
    pollSessionMessages(sess);
  } catch (e) {
    rollbackOptimisticPrompt(sess, localUserMsg, previousTitle, previousUntitled);
    const errMsg = { role: 'error', content: e.message || String(e) };
    sess.messages.push(errMsg);
    if (isActiveSession(sess)) renderMessage(errMsg);
    if (!wasBusy) {
      setBusy(false, null, sess);
      clearSessionStage(sess);
    }
  }
}

function rollbackOptimisticPrompt(sess, localUserMsg, previousTitle, previousUntitled) {
  const idx = sess.messages.indexOf(localUserMsg);
  if (idx !== -1) sess.messages.splice(idx, 1);
  sess.title = previousTitle;
  sess.untitled = previousUntitled;
  if (isActiveSession(sess)) {
    if (sessionTitleEl) sessionTitleEl.textContent = sess.title;
    renderMessages();
  }
  renderSessionList();
}

async function cancelPrompt() {
  const sess = state.sessions.get(state.activeId);
  const runtime = sess ? getSessionRuntime(sess) : null;
  if (!runtime?.busy) return false;
  try {
    const res = await bridgeApi.rpc('session/cancel', { sessionId: sess?.bridgeSessionId || state.activeId });
    if (res.error) throw new Error(res.error.message || res.error);
    return true;
  } catch (e) {
    showSystem('停止失败：' + (e.message || e));
    return false;
  }
}

async function runPiSessionCommand(command, argument = '', sess = state.sessions.get(state.activeId), extra = {}) {
  if (!sess) throw new Error('当前没有活动会话。');
  const sessionId = await ensureBridgeSession(sess);
  const result = await bridgeApi.rpc('session/command', { sessionId, command, argument, ...extra });
  renderSessionList();
  return result;
}

async function runPiExtensionCommand(name, argument, sess) {
  const result = await runPiSessionCommand('invoke', argument, sess, { target: name });
  const notifications = Array.isArray(result?.notifications) ? result.notifications : [];
  if (!notifications.length) {
    showSystem(`/${name} 已执行。`);
    return;
  }
  showSystem(notifications.map((notice) => {
    const prefix = notice.type === 'error' ? '错误' : notice.type === 'warning' ? '警告' : '信息';
    return `[${prefix}] ${notice.message}`;
  }).join('\n'));
}

async function hydrateSessionMessages(sess, options = {}) {
  if (!sess?.bridgeSessionId) return sess;
  const runtime = getSessionRuntime(sess);
  if (runtime.messagesLoading) return runtime.messagesHydrationPromise || sess;
  const requestedLimit = Number(options.limit);
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit >= 0
    ? requestedLimit
    : SESSION_HISTORY_BOOTSTRAP_LIMIT;
  const localMessagesBeforeHydrate = Array.isArray(sess.messages) ? [...sess.messages] : [];
  runtime.messagesLoading = true;
  const hydration = (async () => {
    const payload = await bridgeApi.rpc('session/poll', {
      sessionId: sess.bridgeSessionId,
      after: 0,
      limit,
    });
    const remoteMessages = Array.isArray(payload?.messages) ? payload.messages : [];
    // Preserve optimistic/local records that arrived while the request is in
    // flight, while letting the bridge replace records with the same message ID.
    const messagesById = new Map();
    const unkeyedMessages = [];
    for (const message of localMessagesBeforeHydrate) {
      const messageId = Number(message?.id || 0);
      if (Number.isSafeInteger(messageId) && messageId > 0) messagesById.set(messageId, message);
      else unkeyedMessages.push(message);
    }
    for (const message of remoteMessages) {
      const messageId = Number(message?.id || 0);
      if (Number.isSafeInteger(messageId) && messageId > 0) messagesById.set(messageId, message);
      else unkeyedMessages.push(message);
    }
    const messages = [...messagesById.values(), ...unkeyedMessages];
    messages.sort((left, right) => Number(left?.id || 0) - Number(right?.id || 0));
    sess.messages = messages;
    sess.bridgeMsgSeq = Number(payload?.msgSeq || 0);
    runtime.seenBridgeMessageIds = new Set(messages.map((message) => Number(message.id || 0)).filter(Boolean));
    runtime.lastPolledMessageId = messages.reduce((maximum, message) => Math.max(maximum, Number(message.id || 0)), 0);
    runtime.assistantDraft = null;
    runtime.busy = payload?.status === 'running' || !!payload?.partial;
    runtime.messagesLoaded = true;
    // A bounded page can omit older records. Keep the marker for diagnostics and
    // future on-demand history loading without affecting incremental polling.
    runtime.historyTruncated = limit > 0 && remoteMessages.length >= limit;
    if (payload?.partial) upsertPolledMessage(sess, payload.partial, { partial: true });
    _domCache.delete(sess.id);
    return sess;
  })();
  runtime.messagesHydrationPromise = hydration;
  try {
    return await hydration;
  } finally {
    runtime.messagesLoading = false;
    if (runtime.messagesHydrationPromise === hydration) runtime.messagesHydrationPromise = null;
  }
}

async function activateCommandSession(snapshot, editorText = '', selectionVersion = ++state.sessionSelectionVersion) {
  const bridgeSessionId = bridgeSessionIdFromPayload(snapshot);
  if (!bridgeSessionId) throw new Error('Bridge 没有返回新会话。');
  state.closedBridgeSessionIds.delete(bridgeSessionId);
  state.closedSessionIds.delete(bridgeSessionId);
  const sess = upsertLocalSessionForBridgeSession(snapshot, snapshot?.title || 'Pi 会话');
  if (!sess) throw new Error('无法载入新会话。');
  await hydrateSessionMessages(sess, { limit: SESSION_HISTORY_FULL_LIMIT });
  if (selectionVersion !== state.sessionSelectionVersion || state.sessions.get(sess.id) !== sess) return sess;
  setActiveSession(sess.id);
  if (editorText) {
    inputEl.value = editorText;
    resizeComposerInput();
    saveActiveComposerDraft();
    inputEl.focus();
  }
  await refreshPersistedSessions();
  return sess;
}

function chooseCommandItem(title, items, labelForItem) {
  if (!Array.isArray(items) || !items.length) return null;
  const visible = items.slice(-24);
  const lines = visible.map((item, index) => `${index + 1}. ${labelForItem(item)}`);
  const answer = window.prompt(`${title}\n\n${lines.join('\n')}\n\n输入序号或 ID：`, String(visible.length));
  if (answer === null) return null;
  const value = answer.trim();
  if (/^\d+$/.test(value)) {
    const selected = visible[Number(value) - 1];
    if (selected) return selected;
  }
  return visible.find((item) => String(item.entryId || item.id || '').startsWith(value)) || null;
}

function formatSessionStats(stats = {}) {
  const tokens = stats.tokens || {};
  const context = stats.contextUsage || {};
  const lines = [
    `会话 ID：${stats.sessionId || '未知'}`,
    `消息：${Number(stats.totalMessages || 0).toLocaleString()}（用户 ${Number(stats.userMessages || 0).toLocaleString()} / Agent ${Number(stats.assistantMessages || 0).toLocaleString()}）`,
    `工具调用：${Number(stats.toolCalls || 0).toLocaleString()}`,
    `Token：${Number(tokens.total || 0).toLocaleString()}（输入 ${Number(tokens.input || 0).toLocaleString()} / 输出 ${Number(tokens.output || 0).toLocaleString()}）`,
    `费用：$${Number(stats.cost || 0).toFixed(6)}`,
  ];
  if (Number(context.contextWindow || 0) > 0) {
    lines.push(`上下文：${Number(context.tokens || 0).toLocaleString()} / ${Number(context.contextWindow).toLocaleString()}`);
  }
  if (stats.sessionFile) lines.push(`文件：${stats.sessionFile}`);
  return lines.join('\n');
}

async function resumeWebSession(argument) {
  const selectionVersion = ++state.sessionSelectionVersion;
  const [activeResult, closedResult] = await Promise.all([
    bridgeApi.rpc('session/list', {}),
    bridgeApi.rpc('list_continuable_sessions', {}).catch(() => ({ sessions: [] })),
  ]);
  const candidates = [];
  const seen = new Set();
  for (const [closed, list] of [
    [false, activeResult?.sessions],
    [true, closedResult?.sessions],
  ]) {
    for (const snapshot of Array.isArray(list) ? list : []) {
      const id = bridgeSessionIdFromPayload(snapshot);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      candidates.push({ ...snapshot, closed });
    }
  }
  if (!candidates.length) {
    showSystem('没有可恢复的会话。');
    return;
  }
  let selected = null;
  const query = String(argument || '').trim().toLowerCase();
  if (query) {
    selected = candidates.find((item) => {
      const id = bridgeSessionIdFromPayload(item).toLowerCase();
      const title = String(item.title || '').toLowerCase();
      return id === query || id.startsWith(query) || title === query || title.includes(query);
    }) || null;
  } else {
    selected = chooseCommandItem('恢复会话', candidates, (item) => {
      const id = bridgeSessionIdFromPayload(item).slice(0, 8);
      return `${item.title || '未命名'} [${id}]${item.closed ? '（已关闭）' : ''}`;
    });
  }
  if (!selected) {
    if (query) showSystem(`没有找到会话：${argument}`);
    return;
  }
  let snapshot = selected;
  const sessionId = bridgeSessionIdFromPayload(selected);
  if (selected.closed) {
    const restored = await bridgeApi.rpc('restore_session', { sessionId });
    snapshot = restored?.session || { ...selected, closed: false };
  }
  await activateCommandSession(snapshot, '', selectionVersion);
  showSystem(`已恢复会话：${snapshot.title || sessionId}`);
}

async function handlePiBuiltinSlashCommand(name, argument, sess) {
  const selectionVersion = ++state.sessionSelectionVersion;
  switch (name) {
    case 'model':
    case 'scoped-models':
      await switchAgentFromComposer(argument);
      return true;
    case 'export':
      if (!argument) {
        await exportSession(sess.id);
        showSystem('当前会话已下载。');
      } else {
        const result = await runPiSessionCommand('export', argument, sess);
        showSystem(`会话已导出到服务器：${result.path}`);
      }
      return true;
    case 'import': {
      const path = argument || window.prompt('输入服务器上的 JSONL 文件路径：', '');
      if (!path) return true;
      const result = await runPiSessionCommand('import', path, sess);
      await activateCommandSession(result.session, '', selectionVersion);
      showSystem(`已导入会话：${result.session?.title || result.createdSessionId}`);
      return true;
    }
    case 'share': {
      if (!window.confirm('将当前会话作为私密 GitHub Gist 分享？')) return true;
      const result = await runPiSessionCommand('share', '', sess);
      try {
        await copyText(result.url);
        showSystem(`分享链接已复制：${result.url}`);
      } catch (_) {
        showSystem(`分享链接：${result.url}`);
      }
      return true;
    }
    case 'copy': {
      const message = [...(sess.messages || [])].reverse().find((item) => item.role === 'assistant' || item.role === 'agent');
      const text = message ? messageContentText(message.content) : '';
      if (!text) showSystem('当前还没有可复制的 Agent 回复。');
      else {
        await copyText(text);
        showSystem('最后一条 Agent 回复已复制。');
      }
      return true;
    }
    case 'name': {
      const title = argument || window.prompt('设置会话名称：', sess.title || '');
      if (!title?.trim()) return true;
      const result = await runPiSessionCommand('name', title, sess);
      sess.title = result.title;
      sess.untitled = false;
      if (sessionTitleEl) sessionTitleEl.textContent = result.title;
      renderSessionList();
      showSystem(`会话已重命名为：${result.title}`);
      return true;
    }
    case 'session': {
      const result = await runPiSessionCommand('session', '', sess);
      showSystem(formatSessionStats(result.stats));
      return true;
    }
    case 'changelog':
      showSystem('更新记录：https://github.com/yg2224/SecHeur-Agent-pro/commits/main');
      return true;
    case 'hotkeys':
      showSystem([
        'Enter：发送',
        'Shift+Enter：换行',
        '↑/↓：选择 Slash 命令',
        'Tab：补全 Slash 命令',
        'Esc：关闭补全或停止当前任务',
      ].join('\n'));
      return true;
    case 'fork': {
      let entryId = argument;
      if (!entryId) {
        const catalog = await runPiSessionCommand('fork', '', sess);
        const selected = chooseCommandItem('从哪条用户消息创建分支', catalog.messages, (item) => {
          const preview = String(item.text || '').replace(/\s+/g, ' ').slice(0, 90);
          return `${preview} [${String(item.entryId || '').slice(0, 8)}]`;
        });
        if (!selected) {
          if (!catalog.messages?.length) showSystem('当前会话还没有可分支的用户消息。');
          return true;
        }
        entryId = selected.entryId;
      }
      const result = await runPiSessionCommand('fork', entryId, sess);
      await activateCommandSession(result.session, result.editorText || '', selectionVersion);
      showSystem('已创建会话分支。');
      return true;
    }
    case 'clone': {
      const result = await runPiSessionCommand('clone', '', sess);
      await activateCommandSession(result.session, '', selectionVersion);
      showSystem('已复制当前会话。');
      return true;
    }
    case 'tree': {
      let entryId = argument;
      if (!entryId) {
        const catalog = await runPiSessionCommand('tree', '', sess);
        const selected = chooseCommandItem('切换到会话树节点', catalog.entries, (item) => {
          const preview = String(item.text || item.type || '').replace(/\s+/g, ' ').slice(0, 90);
          const current = item.id === catalog.leafId ? '（当前）' : '';
          return `${preview || item.type} [${String(item.id || '').slice(0, 8)}]${current}`;
        });
        if (!selected) {
          if (!catalog.entries?.length) showSystem('当前会话树为空。');
          return true;
        }
        entryId = selected.id;
      }
      const result = await runPiSessionCommand('tree', entryId, sess);
      await hydrateSessionMessages(sess, { limit: SESSION_HISTORY_FULL_LIMIT });
      renderMessages();
      showSystem(result.navigated ? '已切换会话树节点。' : '当前已经位于该节点。');
      return true;
    }
    case 'trust': {
      let decision = argument;
      if (!decision) {
        const current = await runPiSessionCommand('trust', '', sess);
        decision = window.prompt('保存项目信任决定（yes/no）：', current.decision === false ? 'no' : 'yes') || '';
      }
      if (!decision) return true;
      const result = await runPiSessionCommand('trust', decision, sess);
      showSystem(`已保存项目信任决定：${result.decision ? 'trusted' : 'untrusted'}。重启 Agent 后生效。`);
      return true;
    }
    case 'login':
    case 'logout':
      openSettings('api');
      showSystem(name === 'login' ? '请在 API 设置中添加或更新认证信息。' : '请在 API 设置中删除对应认证配置。');
      return true;
    case 'compact': {
      showSystem('正在压缩当前会话上下文…');
      const result = await runPiSessionCommand('compact', argument, sess);
      const compacted = result.result || {};
      showSystem(`上下文压缩完成：${Number(compacted.tokensBefore || 0).toLocaleString()} → ${Number(compacted.estimatedTokensAfter || 0).toLocaleString()} Token。`);
      return true;
    }
    case 'resume':
      await resumeWebSession(argument);
      return true;
    case 'reload':
      await runPiSessionCommand('reload', '', sess);
      sess.piSlashCommands = null;
      await loadSessionSlashCommands(sess, { force: true });
      showSystem('已重新加载 Pi extensions、skills、prompts、themes 和 context files。');
      return true;
    case 'quit':
      if (state.sessions.size > 1) {
        closeSession(sess.id);
        showSystem('已关闭当前网页会话。');
      } else {
        showSystem('网页版由 Bridge 持续提供服务；关闭浏览器标签页即可退出界面。');
      }
      return true;
    default:
      return false;
  }
}

// ─── Slash commands ──────────────────────────────────────────────────────
async function handleSlash(cmd) {
  const [rawName, ...rest] = cmd.trim().slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  const arg = rest.join(' ');
  const sess = state.sessions.get(state.activeId);

  switch (name) {
    case 'help':
      showSystem([
        '可用命令：',
        ...getSlashCommands(sess).map((item) => `  ${item.usage.padEnd(32)} ${item.desc}`),
        '  /theme 可选：' + [...VALID_THEMES].join('|'),
        '未知 /commands 会透传给 agent。',
      ].join('\n'));
      break;
    case 'new':
      await newSession();
      break;
    case 'clear':
      if (sess) { sess.messages = []; renderMessages(); }
      break;
    case 'stop':
      if (await cancelPrompt()) showSystem('已请求停止。');
      break;
    case 'agent':
      await switchAgentFromComposer(arg);
      break;
    case 'restart':
      await restartBridge();
      break;
    case 'settings':
      openSettings(arg || 'general');
      break;
    case 'mcp':
      await sendPrompt('请调用 mcp_refresh，刷新并列出当前 MCP 工具。', []);
      break;
    case 'skills':
    case 'skill':
      openSettings('skills');
      break;
    case 'plugins':
      openSettings('plugins');
      break;
    case 'memory':
      openSettings('memory');
      break;
    case 'permissions':
      showPermissionModeLocation();
      break;
    case 'theme':
      if (VALID_THEMES.has(arg)) {
        const cfg = getActiveConfig();
        cfg.theme = arg;
        applyTheme();
        applyUiPreferences();
        await persistDesktopConfig(cfg);
        showSystem(`主题已切换为：${THEME_LABELS[arg] || arg}`);
      } else {
        showSystem('用法：/theme ' + [...VALID_THEMES].join('|'));
      }
      break;
    case 'cwd':
      if (!arg) {
        const status = await bridgeApi.checkStatus();
        showSystem(`当前目录：${sess?.cwd || projectRootFromPayload(status)}`);
      } else {
        showSystem(`正在为 ${arg} 创建新会话…`);
        // Need a new session for different cwd
        const config = { ...getActiveConfig() };
        const selectionVersion = ++state.sessionSelectionVersion;
        const res = await bridgeApi.rpc('session/new', { cwd: arg, mcp_servers: [], ...sessionConfigPayload(config) });
        if (res.error) showSystem('失败：' + (res.error.message || res.error));
        else {
          const bridgeSessionId = res.sessionId;
          const ns = upsertLocalSessionForBridgeSession(
            { ...(res.session || {}), id: bridgeSessionId, title: res.session?.title || arg.split('/').pop() || arg, cwd: arg },
            arg.split('/').pop() || arg,
            config,
          );
          if (selectionVersion === state.sessionSelectionVersion) setActiveSession(ns.id);
        }
      }
      break;
    default: {
      const command = findSlashCommand(name, sess);
      if (command?.source === 'builtin' && await handlePiBuiltinSlashCommand(name, arg, sess)) {
        break;
      } else if (command?.source === 'extension') {
        await runPiExtensionCommand(command.name, arg, sess);
      } else if (command?.tuiOnly) {
        showSystem(`/${command.name} 是 Pi TUI 的交互命令，当前网页端暂不执行。`);
      } else {
        await sendPrompt(cmd, []);
      }
    }
  }
}

function showSystem(text) {
  const msg = { role: 'system', content: text };
  const sess = state.sessions.get(state.activeId);
  if (sess) sess.messages.push(msg);
  renderMessage(msg);
  return msg;
}

function updateBridgeNotice(text) {
  const notice = state.bridgeNoticeMessage;
  state.bridgeNoticeMessage = null;
  if (!notice) return;
  notice.content = text;
  const sess = state.sessions.get(state.activeId);
  if (sess && sess.messages.includes(notice)) renderMessages();
}

// ─── Status / UI helpers ─────────────────────────────────────────────────
function setStatus(kind, text) {
  statusBadge.className = 'badge ' + kind;
  statusText.textContent = text;
  statusBadge.title = text;
  statusBadge.setAttribute('aria-label', text);
  updateTabIcon(state.activeId, kind);
}

function updateTabIcon(sessionId, kind) {
  if (!sessionId) return;
  const tab = sessionListEl.querySelector(`[data-session-id="${sessionId}"]`);
  if (!tab) return;
  const icon = tab.querySelector('.tab-icon');
  if (!icon) return;
  icon.className = 'tab-icon';
  if (kind === 'busy') icon.classList.add('busy');
  else if (kind === 'warn') icon.classList.add('warn');
  else if (kind === 'err') icon.classList.add('err');
  // 'ok' = default green (no extra class needed)
}

const SEND_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
const STOP_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>`;

function sendShortcutLabel() {
  return (getActiveConfig().composerSendShortcut || 'enter') === 'cmd-enter' ? 'Cmd/Ctrl+Enter' : 'Enter';
}

function setBusy(busy, label, sess = state.sessions.get(state.activeId)) {
  const runtime = sess ? getSessionRuntime(sess) : null;
  if (runtime) {
    runtime.busy = busy;
    if (busy && label) {
      runtime.currentStageText = label;
      runtime.currentStageKind = runtime.currentStageKind || 'running';
    }
    if (!busy) {
      runtime.currentStageText = '';
      runtime.currentStageKind = '';
    }
  }
  // Always update per-tab dot for this session
  if (sess) {
    const dotKind = busy ? 'busy' : (state.bridgeReady ? 'ok' : 'warn');
    updateTabIcon(sess.id, dotKind);
  }
  if (!isActiveSession(sess)) return;
  if (busy) setStatus('busy', runtime?.currentStageText || label || '处理中…');
  else setStatus(state.bridgeReady ? 'ok' : 'warn', state.bridgeReady ? '就绪' : '启动中…');
  renderComposerActivity();
  renderSendButtonState();
}

function getSendButtonTitle({ busy, attachmentBusy, hasText, hasAttachments }) {
  if (busy && (hasText || hasAttachments)) return '当前任务结束后发送';
  if (busy) return '停止（Esc）';
  if (attachmentBusy) return '正在读取附件…';
  if (!hasText && !hasAttachments) return '输入消息或添加文件后发送';
  return `发送（${sendShortcutLabel()}）`;
}

function renderSendButtonState() {
  const hasText = inputEl.value.trim().length > 0;
  const hasAttachments = state.pendingAttachmentCount > 0;
  const busy = !!getActiveSessionRuntime()?.busy;
  const attachmentBusy = !!state.attachmentSelectionBusy;
  const permissionLocked = busy || attachmentBusy;
  const modelLocked = attachmentBusy;
  const sendTitle = getSendButtonTitle({ busy, attachmentBusy, hasText, hasAttachments });
  sendBtn.classList.toggle('stop', busy && !hasText && !hasAttachments);
  sendBtn.title = sendTitle;
  sendBtn.setAttribute('aria-label', sendTitle);
  sendBtn.innerHTML = busy && !hasText && !hasAttachments ? STOP_ICON : SEND_ICON;
  sendBtn.disabled = !busy && (attachmentBusy || (!hasText && !hasAttachments));
  if (composerPermissionSelect) {
    composerPermissionSelect.disabled = permissionLocked;
    composerPermissionSelect.title = busy
      ? '当前任务运行中，停止后可切换权限'
      : (attachmentBusy ? '正在读取附件，稍后可切换权限' : '权限模式');
  }
  if (composerModelSelect) {
    composerModelSelect.disabled = modelLocked;
    composerModelSelect.title = attachmentBusy ? '正在读取附件，稍后可切换模型' : '模型';
  }
  if (composerApiModelSelect) {
    composerApiModelSelect.disabled = modelLocked || !apiModelOptionsAvailable();
    composerApiModelSelect.title = modelLocked
      ? '正在读取附件，稍后可切换 API 模型'
      : (apiModelOptionsAvailable() ? 'API 模型' : '先在 API 设置中获取模型');
  }
  syncComposerPopupSelect(composerModelSelect);
  syncComposerPopupSelect(composerApiModelSelect);
}

function updateSendButton() {
  renderSendButtonState();
}

function slashIconSvg() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M10 19 14 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
    </svg>`;
}

function getSlashContext() {
  const value = inputEl.value || '';
  if (!value.startsWith('/')) return null;
  const cursor = inputEl.selectionStart ?? value.length;
  const firstBreak = value.search(/\r|\n/);
  if (firstBreak >= 0 && cursor > firstBreak) return null;
  const firstLine = firstBreak >= 0 ? value.slice(0, firstBreak) : value;
  const match = firstLine.match(/^\/([^\s]*)/);
  if (!match) return null;
  return {
    value,
    query: match[1].toLowerCase(),
    commandText: match[1],
    tokenEnd: match[0].length,
    rest: firstLine.slice(match[0].length),
  };
}

function getSlashMatches(query) {
  const normalized = String(query || '').toLowerCase();
  const commands = getSlashCommands();
  const starts = commands.filter((cmd) => cmd.name.toLowerCase().startsWith(normalized));
  const contains = commands.filter((cmd) => !cmd.name.toLowerCase().startsWith(normalized)
    && cmd.name.toLowerCase().includes(normalized));
  return [...starts, ...contains];
}

function renderSlashHighlight() {
  if (!slashHighlightEl) return;
  const ctx = getSlashContext();
  if (!ctx) {
    slashHighlightEl.innerHTML = '';
    inputEl.classList.remove('slash-active');
    return;
  }
  const value = inputEl.value || '';
  const command = value.slice(0, ctx.tokenEnd);
  const rest = value.slice(ctx.tokenEnd);
  slashHighlightEl.innerHTML = (
    `<span class="slash-command-token">${escapeHtml(command)}</span>` +
    `<span class="slash-argument-token">${escapeHtml(rest || '\n')}</span>`
  );
  slashHighlightEl.scrollTop = inputEl.scrollTop;
  inputEl.classList.add('slash-active');
}

function setSlashAutocompleteVisible(visible, activeId = '') {
  if (!slashAutocompleteEl) return;
  slashAutocompleteEl.classList.toggle('hidden', !visible);
  slashAutocompleteEl.setAttribute('aria-hidden', visible ? 'false' : 'true');
  inputEl.setAttribute('aria-expanded', visible ? 'true' : 'false');
  if (visible && activeId) {
    inputEl.setAttribute('aria-activedescendant', activeId);
  } else {
    inputEl.removeAttribute('aria-activedescendant');
  }
}

function renderSlashAutocomplete(resetIndex = false) {
  if (!slashAutocompleteEl) return;
  const ctx = getSlashContext();
  if (!ctx || ctx.rest.startsWith(' ')) {
    slashAutocompleteEl.textContent = '';
    setSlashAutocompleteVisible(false);
    return;
  }
  const matches = getSlashMatches(ctx.query);
  if (!matches.length) {
    slashAutocompleteEl.textContent = '';
    setSlashAutocompleteVisible(false);
    return;
  }
  if (resetIndex) slashSuggestionIndex = 0;
  slashSuggestionIndex = Math.max(0, Math.min(slashSuggestionIndex, matches.length - 1));
  slashAutocompleteEl.textContent = '';
  matches.forEach((cmd, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.id = `slash-suggestion-${index}`;
    row.className = 'slash-suggestion' + (index === slashSuggestionIndex ? ' active' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', index === slashSuggestionIndex ? 'true' : 'false');
    const optionLabel = `/${cmd.name}：${cmd.desc}。用法：${cmd.usage}`;
    row.setAttribute('aria-label', optionLabel);
    row.title = optionLabel;
    row.dataset.command = cmd.name;
    row.innerHTML = `
      <span class="slash-suggestion-icon">${slashIconSvg()}</span>
      <span class="slash-suggestion-main">
        <span class="slash-suggestion-command">/${escapeHtml(cmd.name)}</span>
        <span class="slash-suggestion-desc">${escapeHtml(cmd.desc)}</span>
      </span>
      <span class="slash-suggestion-usage">${escapeHtml(cmd.usage)}</span>`;
    row.addEventListener('mouseenter', () => {
      slashSuggestionIndex = index;
      renderSlashAutocomplete(false);
    });
    row.addEventListener('mousedown', (event) => {
      event.preventDefault();
      applySlashCompletion(cmd);
    });
    slashAutocompleteEl.appendChild(row);
  });
  setSlashAutocompleteVisible(true, `slash-suggestion-${slashSuggestionIndex}`);
  slashAutocompleteEl.querySelector('.slash-suggestion.active')?.scrollIntoView({ block: 'nearest' });
}

function updateSlashAssist(resetIndex = false) {
  renderSlashHighlight();
  renderSlashAutocomplete(resetIndex);
}

function hideSlashAutocomplete() {
  setSlashAutocompleteVisible(false);
}

function clearSlashAssist() {
  if (slashHighlightEl) slashHighlightEl.innerHTML = '';
  inputEl.classList.remove('slash-active');
  hideSlashAutocomplete();
  if (slashAutocompleteEl) slashAutocompleteEl.textContent = '';
}

function applySlashCompletion(cmd) {
  const ctx = getSlashContext();
  if (!ctx || !cmd) return false;
  const needsSpace = Boolean(cmd.argumentHint);
  const suffix = ctx.rest && ctx.rest.startsWith(' ') ? ctx.rest : (needsSpace ? ' ' : '');
  inputEl.value = `/${cmd.name}${suffix}`;
  const pos = Math.min(inputEl.value.length, (`/${cmd.name}${needsSpace ? ' ' : ''}`).length);
  inputEl.setSelectionRange(pos, pos);
  resizeComposerInput();
  saveActiveComposerDraft();
  updateSlashAssist(true);
  updateSendButton();
  return true;
}

function moveSlashSuggestion(delta) {
  const ctx = getSlashContext();
  if (!ctx || ctx.rest.startsWith(' ') || slashAutocompleteEl?.classList.contains('hidden')) return false;
  const matches = getSlashMatches(ctx.query);
  if (!matches.length) return false;
  slashSuggestionIndex = (slashSuggestionIndex + delta + matches.length) % matches.length;
  renderSlashAutocomplete(false);
  return true;
}

function completeActiveSlashSuggestion() {
  const ctx = getSlashContext();
  if (!ctx || ctx.rest.startsWith(' ') || slashAutocompleteEl?.classList.contains('hidden')) return false;
  const matches = getSlashMatches(ctx.query);
  const cmd = matches[slashSuggestionIndex];
  return applySlashCompletion(cmd);
}

function showError(text, actionLabel, actionFn, options = {}) {
  if (!options.skipDiagnostic) addDiagnostic('error', text);
  $('error-text').textContent = text;
  const actionBtn = $('error-action');
  if (actionLabel && actionFn) {
    actionBtn.textContent = actionLabel;
    actionBtn.classList.remove('hidden');
    actionBtn.onclick = async () => {
      try {
        await actionFn();
      } catch (err) {
        showError('操作失败：' + (err.message || err));
      }
    };
  } else {
    actionBtn.textContent = '';
    actionBtn.onclick = null;
    actionBtn.classList.add('hidden');
  }
  errorBanner.classList.remove('hidden');
  clearTimeout(showError._t);
  if (!actionLabel && !options.persist) {
    showError._t = setTimeout(() => hideError(), 6000);
  }
}
function hideError() {
  clearTimeout(showError._t);
  showError._t = null;
  errorBanner.classList.add('hidden');
}

// ─── Theme ───────────────────────────────────────────────────────────────
function applyTheme() {
  const cfg = getActiveConfig();
  document.documentElement.setAttribute('data-theme', cfg.theme || 'white');
  setThemeSelection(cfg.theme || 'white');
}

function themeIconSvg(theme) {
  const [bg, surface, accent] = theme.colors;
  return `
    <svg viewBox="0 0 36 36" aria-hidden="true" focusable="false">
      <rect x="3" y="3" width="30" height="30" rx="8" fill="${bg}"></rect>
      <path d="M11 11h14a3 3 0 0 1 3 3v11H8V14a3 3 0 0 1 3-3Z" fill="${surface}"></path>
      <circle cx="13" cy="15" r="2" fill="${accent}"></circle>
      <path d="M17 15h7M12 21h12M12 25h8" stroke="${accent}" stroke-width="2" stroke-linecap="round"></path>
    </svg>`;
}

function renderThemePicker() {
  const picker = $('theme-picker');
  if (!picker || picker.dataset.ready === '1') return;
  picker.dataset.ready = '1';
  picker.textContent = '';
  for (const theme of THEME_OPTIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-choice';
    btn.dataset.theme = theme.id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', theme.label);
    btn.title = theme.label;
    btn.innerHTML = themeIconSvg(theme);
    btn.addEventListener('click', () => {
      const input = $('cfg-theme');
      if (input) input.value = theme.id;
      const sess = state.sessions.get(state.activeId);
      if (sess) sess.config.theme = theme.id;
      applyTheme();
    });
    picker.appendChild(btn);
  }
}

function setThemeSelection(theme) {
  const picker = $('theme-picker');
  if (!picker) return;
  const selected = VALID_THEMES.has(theme) ? theme : 'auto';
  picker.querySelectorAll('.theme-choice').forEach((btn) => {
    const active = btn.dataset.theme === selected;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
    btn.tabIndex = active ? 0 : -1;
  });
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeHex(value, fallback) {
  const text = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(text) ? text : fallback;
}

function normalizeFontStack(value, fallback) {
  const text = String(value || '').trim();
  return text || fallback;
}

const SETTINGS_FIELDS = [
  { id: 'cfg-theme', key: 'theme', fallback: 'white' },
  { id: 'cfg-send-shortcut', key: 'composerSendShortcut', fallback: 'enter' },
  { id: 'cfg-ui-scale', key: 'uiScale', fallback: 100, read: (el) => clampNumber(el.value, 80, 140, 100) },
  { id: 'cfg-canvas-width', key: 'canvasWidthMode', fallback: 'narrow' },
  { id: 'cfg-user-msg-color', key: 'userMsgColor', fallback: '#005fb8', format: (value) => normalizeHex(value, '#005fb8'), read: (el) => normalizeHex(el.value, '#005fb8') },
  { id: 'cfg-ui-font', key: 'uiFontFamily', fallback: '' },
  { id: 'cfg-code-font', key: 'codeFontFamily', fallback: '' },
  { id: 'cfg-code-font-size', key: 'codeFontSize', fallback: 13, read: (el) => clampNumber(el.value, 11, 18, 13) },
  { id: 'cfg-backend-mode', key: 'backendMode', fallback: 'local' },
  { id: 'cfg-max-turns', key: 'maxTurns', fallback: 80, read: (el) => {
    const value = parseInt(el.value || '80', 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : 80;
  } },
  { id: 'cfg-max-cost', key: 'maxCost', fallback: '' },
  { id: 'cfg-thinking', key: 'thinkingMode', fallback: 'adaptive' },
  { id: 'cfg-thinking-budget', key: 'thinkingBudget', fallback: '' },
  { id: 'cfg-agent-output-idle-timeout', key: 'agentOutputIdleTimeoutSeconds', fallback: 600, read: (el) => Math.max(30, parseInt(el.value || '600', 10) || 600) },
  { id: 'cfg-agent-first-output-timeout', key: 'agentFirstOutputTimeoutSeconds', fallback: 120, read: (el) => Math.max(30, parseInt(el.value || '120', 10) || 120) },
  { id: 'cfg-auto-compaction-threshold', key: 'autoCompactionThresholdPercent', fallback: 85, read: (el) => clampNumber(el.value, 50, 95, 85) },
  { id: 'cfg-hot-runtimes', key: 'maxHotRuntimes', fallback: 1, read: (el) => clampNumber(el.value, 0, 8, 1) },
  { id: 'cfg-warm-runtimes', key: 'maxWarmRuntimes', fallback: 1, read: (el) => clampNumber(el.value, 0, 8, 1) },
  { id: 'cfg-warm-ttl', key: 'warmTtlSeconds', fallback: 7200, read: (el) => Math.max(60, parseInt(el.value || '7200', 10) || 7200) },
  { id: 'cfg-system-proxy-url', key: 'systemProxyUrl', fallback: '' },
  { id: 'cfg-terminal-shell', key: 'terminalShellPath', fallback: '' },
  { id: 'cfg-custom-skill-dirs', key: 'customSkillDirectories', fallback: '' },
  { id: 'cfg-open-app-targets', key: 'openAppTargets', fallback: '' },
];

const SETTINGS_CHECKBOXES = [
  { id: 'cfg-streaming-enabled', key: 'streamingEnabled', enabledByDefault: true },
  { id: 'cfg-browser-agent-enabled', key: 'browserAgentEnabled', enabledByDefault: true },
  { id: 'cfg-browser-agent-builtin', key: 'browserAgentPreferBuiltIn', enabledByDefault: true },
  { id: 'cfg-browser-agent-fallback', key: 'browserAgentAllowExternalProviderFallback', enabledByDefault: true },
  { id: 'cfg-system-proxy-enabled', key: 'systemProxyEnabled', enabledByDefault: false },
  { id: 'cfg-notification-sounds', key: 'notificationSoundsEnabled', enabledByDefault: true },
  { id: 'cfg-system-notification', key: 'systemNotificationEnabled', enabledByDefault: true },
  { id: 'cfg-auto-compaction', key: 'autoCompactionEnabled', enabledByDefault: true },
  { id: 'cfg-attempt-dedup', key: 'attemptDedupEnabled', enabledByDefault: false },
  { id: 'cfg-memory-enabled', key: 'memoryReferenceEnabled', enabledByDefault: true },
  { id: 'cfg-knowledge-base-enabled', key: 'knowledgeBaseEnabled', enabledByDefault: false },
  { id: 'cfg-mcp-autorefresh', key: 'mcpAutoRefresh', enabledByDefault: false },
  { id: 'cfg-preload-git-diffs', key: 'preloadGitDiffs', enabledByDefault: true },
  { id: 'cfg-auto-open-file', key: 'autoOpenFileEnabled', enabledByDefault: false },
  { id: 'cfg-diff-expanded', key: 'diffExpandedByDefault', enabledByDefault: false },
];

function settingValue(cfg, field) {
  const value = cfg[field.key];
  const fallback = field.fallback ?? '';
  const normalized = value === undefined || value === null || value === '' ? fallback : value;
  return field.format ? field.format(normalized) : normalized;
}

function hydrateSettingControls(cfg) {
  for (const field of SETTINGS_FIELDS) {
    const el = $(field.id);
    if (el) el.value = String(settingValue(cfg, field));
  }
  for (const field of SETTINGS_CHECKBOXES) {
    const el = $(field.id);
    if (el) el.checked = field.enabledByDefault ? cfg[field.key] !== false : !!cfg[field.key];
  }
}

function readSettingControls(cfg) {
  for (const field of SETTINGS_FIELDS) {
    const el = $(field.id);
    if (el) cfg[field.key] = field.read ? field.read(el) : el.value || field.fallback || '';
  }
  for (const field of SETTINGS_CHECKBOXES) {
    const el = $(field.id);
    if (el) cfg[field.key] = field.enabledByDefault ? el.checked !== false : !!el.checked;
  }
}

function applyUiPreferences() {
  const cfg = getActiveConfig();
  const root = document.documentElement;
  const scale = clampNumber(cfg.uiScale, 80, 140, 100) / 100;
  const userColor = normalizeHex(cfg.userMsgColor, '');
  root.style.setProperty('--density-scale', String(scale));
  if (userColor) root.style.setProperty('--user-bg', userColor);
  else root.style.removeProperty('--user-bg');
  root.style.setProperty('--font', normalizeFontStack(cfg.uiFontFamily, '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif'));
  root.style.setProperty('--font-mono', normalizeFontStack(cfg.codeFontFamily, '"SF Mono", "SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", monospace'));
  root.style.setProperty('--code-font-size', `${clampNumber(cfg.codeFontSize, 11, 18, 13)}px`);
  document.body.dataset.canvasWidth = cfg.canvasWidthMode || 'narrow';
}

// ─── Settings modal ──────────────────────────────────────────────────────
function renderModelOptions() {
  const sess = state.sessions.get(state.activeId);
  const selected = sess?.composerModelValue || String(getActiveConfig().llmNo || 0);
  const profiles = Array.isArray(state.modelProfiles) ? state.modelProfiles : [];
  const options = profiles.length ? profiles : [{ llmNo: 0, name: '默认 / 自动' }];
  const fillSelect = (target) => {
    if (!target) return;
    target.textContent = '';
    for (const profile of options) {
      const opt = document.createElement('option');
      opt.value = String(modelProfileId(profile));
      opt.textContent = modelProfileLabel(profile);
      target.appendChild(opt);
    }
    if (![...target.options].some((opt) => opt.value === selected)) {
      const opt = document.createElement('option');
      opt.value = selected;
      opt.textContent = selected === '0' ? '默认 / 自动' : `模型 ${selected}`;
      target.appendChild(opt);
    }
    target.value = selected;
  };
  fillSelect(composerModelSelect);
  syncComposerPopupSelect(composerModelSelect);
}

function apiModelOptionsAvailable() {
  return (
    state.apiModelsContextKey === apiModelsContextKey(activeApiFetchConfig())
    && Array.isArray(state.apiModels)
    && state.apiModels.some((model) => model && model.id)
  );
}

function renderApiModelOptions() {
  if (!composerApiModelSelect) return;
  const sess = state.sessions.get(state.activeId);
  const currentApi = composerApiContext(sess).config || {};
  const currentModel = String(currentApi.model || '').trim();
  const selected = sess?.composerApiModelValue || currentModel || '';
  const apiModels = Array.isArray(state.apiModels) ? state.apiModels.filter((model) => model && model.id) : [];
  composerApiModelSelect.textContent = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = apiModels.length ? 'API 模型' : '先获取 API 模型';
  composerApiModelSelect.appendChild(placeholder);
  for (const model of apiModels) {
    const opt = document.createElement('option');
    opt.value = model.id;
    opt.textContent = model.name && model.name !== model.id ? `${model.name} / ${model.id}` : model.id;
    composerApiModelSelect.appendChild(opt);
  }
  if (selected && ![...composerApiModelSelect.options].some((opt) => opt.value === selected)) {
    const opt = document.createElement('option');
    opt.value = selected;
    opt.textContent = selected;
    composerApiModelSelect.appendChild(opt);
  }
  composerApiModelSelect.value = selected;
  syncComposerPopupSelect(composerApiModelSelect);
}

function renderComposerControls() {
  const cfg = getActiveConfig();
  const graphButton = $('artex-graph-btn');
  if (graphButton) {
    graphButton.hidden = state.sessions.get(state.activeId)?.planningEngine !== 'artex';
    graphButton.onclick = async () => {
      const session = state.sessions.get(state.activeId);
      const dialog = $('artex-graph-dialog');
      const content = $('artex-graph-content');
      if (!session || !dialog || !content) return;
      content.textContent = '正在读取探索图…';
      dialog.showModal();
      $('artex-graph-close').onclick = () => dialog.close();
      try {
        const sessionId = session.bridgeSessionId || session.id;
        const result = await bridgeApi.rpc('planning/graph/get', { sessionId });
        content.textContent = '';
        const summary = document.createElement('p');
        summary.textContent = `第 ${result.graph.round} 轮；${result.graph.nodes.length} 个可见节点；${result.graph.foldedNodeCount} 个折叠节点`;
        content.appendChild(summary);
        const records = document.createElement('pre');
        records.style.whiteSpace = 'pre-wrap';
        records.textContent = JSON.stringify(result.graph, null, 2);
        content.appendChild(records);
        for (const digest of result.graph.digests) {
          for (const node of digest.memberIds) {
            const button = document.createElement('button');
            button.textContent = `读取原节点 ${node}`;
            button.onclick = async () => {
              try {
                const original = await bridgeApi.rpc('planning/graph/get', { sessionId, node });
                records.textContent = JSON.stringify(original.node, null, 2);
              } catch (error) { records.textContent = String(error); }
            };
            content.appendChild(button);
          }
        }
      } catch (error) { content.textContent = String(error); }
    };
  }
  const planStatus = $('new-session-plan-status');
  const currentSession = state.sessions.get(state.activeId);
  if (planStatus && !state.planningSelectionSaving) {
    const currentMode = currentSession?.executionMode === 'direct' ? 'Direct' : currentSession?.planningEngine || '未知';
    planStatus.textContent = `当前会话：${currentMode}；选择仅对新会话生效`;
  }
  if (composerPermissionSelect) {
    const mode = cfg.permissionMode || 'default';
    composerPermissionSelect.value = COMPOSER_PERMISSION_LABELS[mode] ? mode : 'default';
  }
  if (composerModelSelect) {
    const sess = state.sessions.get(state.activeId);
    composerModelSelect.value = sess?.composerModelValue || String(cfg.llmNo || 0);
  }
  renderApiModelOptions();
  renderSendButtonState();
}

function reconcileModelSelectionAfterProfiles() {
  const profiles = Array.isArray(state.modelProfiles) ? state.modelProfiles : [];
  const selectableProfiles = profiles.length ? profiles : [{ llmNo: 0 }];
  const cfg = getActiveConfig();
  const selected = Math.max(0, parseInt(cfg.llmNo || '0', 10) || 0);
  const validIds = new Set(selectableProfiles.map((profile) => modelProfileId(profile)));
  if (validIds.has(selected)) return null;
  cfg.llmNo = 0;
  renderComposerControls();
  return selected;
}

async function syncReconciledModelSelection(previousModelNo) {
  if (previousModelNo === null) return;
  const sess = state.sessions.get(state.activeId);
  const cfg = sess ? sess.config : state.defaultConfig;
  await persistDesktopConfig(cfg).catch((err) => addDiagnostic('warn', '保存模型选择失败', err));
  if (!sess || !sess.bridgeSessionId || getSessionRuntime(sess)?.busy) return;
  try {
    await bridgeApi.rpc('session/model', { sessionId: sess.bridgeSessionId, llmNo: 0 });
  } catch (err) {
    addDiagnostic('warn', '同步模型选择失败', err);
  }
}

function sessionConfigPayload(cfg = getActiveConfig()) {
  const permissionMode = COMPOSER_PERMISSION_LABELS[cfg.permissionMode] ? cfg.permissionMode : 'default';
  return {
    llmNo: Math.max(0, parseInt(cfg.llmNo || '0', 10) || 0),
    permissionMode,
    memoryReferenceEnabled: cfg.memoryReferenceEnabled !== false,
    knowledgeBaseEnabled: cfg.knowledgeBaseEnabled === true,
    ...(state.newSessionPlanningEngine ? { planningEngine: state.newSessionPlanningEngine, executionMode: 'plan_multi' } : {}),
  };
}

async function loadModelProfiles() {
  try {
    const result = await bridgeApi.getModelProfiles();
    state.modelProfiles = Array.isArray(result && result.profiles) ? result.profiles : [];
    const previousModelNo = reconcileModelSelectionAfterProfiles();
    renderModelOptions();
    renderJudgeModelProfileOptions(getActiveConfig().judge?.model_profile || '');
    await syncReconciledModelSelection(previousModelNo);
  } catch (err) {
    addDiagnostic('warn', '加载模型名称失败', err);
    renderModelOptions();
    renderJudgeModelProfileOptions(getActiveConfig().judge?.model_profile || '');
  }
}

async function ensureModelProfiles() {
  if (!Array.isArray(state.modelProfiles) || !state.modelProfiles.length) {
    await loadModelProfiles();
  }
  return Array.isArray(state.modelProfiles) ? state.modelProfiles : [];
}

function findModelProfile(query, profiles) {
  const text = String(query || '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const numeric = Number.parseInt(text, 10);
    return profiles.find(profile => modelProfileId(profile) === numeric) || null;
  }
  const lowered = text.toLowerCase();
  return profiles.find(profile => {
    const haystack = [
      modelProfileId(profile),
      profile.name,
      profile.model,
      modelProfileLabel(profile)
    ].join(' ').toLowerCase();
    return haystack.includes(lowered);
  }) || null;
}

async function switchAgentFromComposer(query) {
  const sess = state.sessions.get(state.activeId);
  if (!sess) {
    showSystem('当前没有活动会话。');
    return;
  }
  if (getSessionRuntime(sess)?.busy) {
    showSystem('Agent 正在回复，停止后再切换。');
    return;
  }
  const profiles = await ensureModelProfiles();
  if (!profiles.length) {
    showSystem('还没有可用的 Agent / 模型 profile。先在设置 → API 添加配置。');
    return;
  }
  if (!String(query || '').trim()) {
    const current = Number(sess.config.llmNo || 0);
    const lines = profiles.map(profile => {
      const id = modelProfileId(profile);
      const mark = id === current ? '当前' : '可选';
      return `  ${id}. ${modelProfileLabel(profile)}（${mark}）`;
    });
    showSystem(['用法：/agent 序号或名称', ...lines].join('\n'));
    return;
  }
  const profile = findModelProfile(query, profiles);
  if (!profile) {
    showSystem(`没有找到 Agent：${query}\n输入 /agent 查看可用项。`);
    return;
  }
  const llmNo = modelProfileId(profile);
  const previous = Math.max(0, parseInt(sess.config.llmNo || '0', 10) || 0);
  sess.config.llmNo = llmNo;
  renderModelOptions();
  renderComposerControls();
  try {
    if (sess.bridgeSessionId) {
      await bridgeApi.rpc('session/model', { sessionId: sess.bridgeSessionId, llmNo });
    }
    await persistDesktopConfig(sess.config);
  } catch (err) {
    sess.config.llmNo = previous;
    renderModelOptions();
    renderComposerControls();
    await persistDesktopConfig(sess.config).catch(() => {});
    showError('切换 Agent 失败：' + (err.message || err));
    return;
  }
  showSystem(`已切换 Agent：${modelProfileLabel(profile)}`);
}

function showPermissionModeLocation() {
  ensureChatView();
  showSystem('权限模式已移到输入条左下角的权限选择器。');
  composerPermissionSelect?.focus();
}

function renderApiConfigForm(payload) {
  const data = payload || state.apiConfig || {};
  const cfg = data.config || {};
  const setValue = (id, value) => {
    const el = $(id);
    if (el) el.value = value == null ? '' : String(value);
  };
  const setChecked = (id, value) => {
    const el = $(id);
    if (el) el.checked = !!value;
  };
  setValue('cfg-api-type', cfg.type || 'native_oai');
  setValue('cfg-api-name', cfg.name || '');
  setValue('cfg-api-base', cfg.apibase || '');
  setValue('cfg-api-model', cfg.model || '');
  renderFetchedApiModels([], cfg.model || '');
  setValue('cfg-api-key', '');
  setValue('cfg-api-mode', cfg.api_mode || 'chat_completions');
  setValue('cfg-api-thinking', cfg.thinking_type || 'adaptive');
  setValue('cfg-api-proxy', cfg.proxy || '');
  setChecked('cfg-api-relay-compat', !!cfg.relay_compat_system_prompt);
  const status = $('api-config-status');
  if (status) {
    status.textContent = data.hasApiKey
      ? `当前已保存：${cfg.name || cfg.model || '未命名'} · ${data.maskedApiKey || '****'}`
      : '当前还没有可用的真实 API Key。';
  }
  renderApiProfiles(data.profiles || []);
}

function renderFetchedApiModels(models, selectedModel = '') {
  const select = $('cfg-api-model-select');
  if (!select) return;
  const current = String(selectedModel || $('cfg-api-model')?.value || '').trim();
  const normalized = Array.isArray(models) ? models.filter((model) => model && model.id) : [];
  select.textContent = '';
  if (!normalized.length) {
    const opt = document.createElement('option');
    opt.value = current;
    opt.textContent = current ? `当前：${current}` : '点击获取模型后选择';
    select.appendChild(opt);
    select.disabled = true;
    return;
  }
  for (const model of normalized) {
    const opt = document.createElement('option');
    opt.value = model.id;
    opt.textContent = model.name && model.name !== model.id ? `${model.name} / ${model.id}` : model.id;
    select.appendChild(opt);
  }
  const values = new Set(normalized.map((model) => model.id));
  select.value = values.has(current) ? current : normalized[0].id;
  select.disabled = false;
  const input = $('cfg-api-model');
  if (input) input.value = select.value;
}

function clearApiConfigForm() {
  renderApiConfigForm({ config: { type: 'native_oai', api_mode: 'chat_completions' }, profiles: state.apiConfig?.profiles || [] });
  const status = $('api-config-status');
  if (status) status.textContent = '正在新增 API profile。填写显示名称、API Base、Model 和 API Key 后保存。';
  $('cfg-api-name')?.focus();
}

function renderApiProfiles(profiles) {
  const list = $('api-profile-list');
  const count = $('api-profile-count');
  if (count) count.textContent = `API profile：${profiles.length} 个`;
  if (!list) return;
  list.textContent = '';
  if (!profiles.length) {
    list.appendChild(createEmptyState('还没有保存 API profile。填写下面表单后点击保存即可添加。'));
    return;
  }
  for (const profile of profiles) {
    const profileName = profile.name || '';
    const row = setDataset(createEl('div', 'registry-item registry-item-button api-profile-item'), { apiProfileName: profileName });
    const title = appendChildren(
      createEl('div', 'registry-item-title'),
      createEl('span', '', profile.name || profile.model || '未命名'),
      createEl('span', 'registry-pill', profile.active ? '当前' : (profile.type || 'profile'))
    );
    const desc = createEl('div', 'registry-item-desc', [
      profile.model,
      profile.apibase,
      profile.hasApiKey ? profile.maskedApiKey : '未保存 Key',
    ].filter(Boolean).join(' · '));
    const actions = appendChildren(
      createEl('div', 'registry-item-actions'),
      createSmallActionButton('编辑', { apiProfileAction: 'edit', apiProfileName: profileName }),
      createSmallActionButton('删除', { apiProfileAction: 'delete', apiProfileName: profileName }, !profileName)
    );
    appendChildren(row, appendChildren(createEl('div', 'registry-item-main'), title, desc), actions);
    list.appendChild(row);
  }
}

async function loadApiConfig() {
  try {
    const result = await bridgeApi.getApiConfig();
    state.apiConfig = result || null;
    for (const sess of state.sessions.values()) syncComposerApiModelFromSelectedProfile(sess);
    renderApiConfigForm(state.apiConfig);
    renderModelOptions();
    renderApiModelOptions();
    refreshComposerApiModels({ silent: true });
  } catch (err) {
    addDiagnostic('warn', '加载 API 配置失败', err);
    const status = $('api-config-status');
    if (status) status.textContent = 'API 配置读取失败：' + (err.message || err);
  }
}

function activeApiFetchConfig(modelOverride = '') {
  const context = composerApiContext();
  const cfg = context.config || {};
  return {
    type: cfg.type || 'native_oai',
    name: cfg.name || '',
    apibase: cfg.apibase || '',
    model: modelOverride || cfg.model || '',
    api_mode: cfg.api_mode || 'chat_completions',
    apikey: '',
    savedApiKey: !!context.hasApiKey,
  };
}

function ensureComposerApiModelsForActiveSession() {
  const cfg = activeApiFetchConfig();
  const key = apiModelsContextKey(cfg);
  if (!cfg.apibase || !cfg.savedApiKey) {
    state.apiModels = [];
    state.apiModelsContextKey = key;
    renderApiModelOptions();
    renderSendButtonState();
    return;
  }
  if (state.apiModelsContextKey === key && apiModelOptionsAvailable()) return;
  refreshComposerApiModels({ silent: true });
}

async function refreshComposerApiModels({ silent = false } = {}) {
  const cfg = activeApiFetchConfig();
  const key = apiModelsContextKey(cfg);
  if (!cfg.apibase || !cfg.savedApiKey) {
    state.apiModels = [];
    state.apiModelsContextKey = key;
    renderModelOptions();
    renderApiModelOptions();
    renderSendButtonState();
    return [];
  }
  try {
    const result = await bridgeApi.fetchApiModels(cfg);
    if (result?.ok === false) throw new Error(result.error || '获取模型失败');
    state.apiModels = Array.isArray(result?.models) ? result.models : [];
    state.apiModelsContextKey = key;
    renderModelOptions();
    renderApiModelOptions();
    renderSendButtonState();
    return state.apiModels;
  } catch (err) {
    state.apiModels = [];
    state.apiModelsContextKey = key;
    renderModelOptions();
    renderApiModelOptions();
    renderSendButtonState();
    addDiagnostic(silent ? 'warn' : 'error', '刷新输入框 API 模型失败', err);
    if (!silent) showError('刷新 API 模型失败：' + (err.message || err));
    return [];
  }
}

function readApiFetchConfigFromSettings() {
  return {
    type: $('cfg-api-type')?.value || 'native_oai',
    name: $('cfg-api-name')?.value || '',
    apibase: $('cfg-api-base')?.value || '',
    model: $('cfg-api-model')?.value || '',
    api_mode: $('cfg-api-mode')?.value || 'chat_completions',
    apikey: $('cfg-api-key')?.value || '',
    savedApiKey: !!state.apiConfig?.hasApiKey,
  };
}

async function fetchApiModelsFromSettings() {
  const btn = $('fetch-api-models');
  const status = $('api-config-status');
  const cfg = readApiFetchConfigFromSettings();
  if (!cfg.apibase.trim()) {
    showError('请先填写 API Base。');
    $('cfg-api-base')?.focus();
    return;
  }
  if (!cfg.apikey.trim() && !cfg.savedApiKey) {
    showError('请先填写 API Key，或先保存已有 API 配置。');
    $('cfg-api-key')?.focus();
    return;
  }
  if (btn) btn.disabled = true;
  if (status) status.textContent = '正在获取模型列表…';
  try {
    const result = await bridgeApi.fetchApiModels(cfg);
    if (result?.ok === false) throw new Error(result.error || '获取模型失败');
    const models = Array.isArray(result?.models) ? result.models : [];
    const settingsKey = apiModelsContextKey({
      type: cfg.type,
      name: cfg.name,
      apibase: cfg.apibase,
      api_mode: cfg.api_mode,
    });
    if (settingsKey === apiModelsContextKey(activeApiFetchConfig())) {
      state.apiModels = models;
      state.apiModelsContextKey = settingsKey;
    }
    renderFetchedApiModels(models, $('cfg-api-model')?.value || '');
    renderModelOptions();
    renderApiModelOptions();
    renderSendButtonState();
    if (status) status.textContent = `已获取 ${models.length} 个模型，选择后保存 API 配置。`;
  } catch (err) {
    addDiagnostic('error', '获取 API 模型失败', err);
    if (status) status.textContent = '获取模型失败：' + (err.message || err);
    showError('获取模型失败：' + (err.message || err));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function testApiResponseFromSettings() {
  const btn = $('test-api-response');
  const status = $('api-config-status');
  const cfg = readApiFetchConfigFromSettings();
  if (!cfg.apibase.trim()) {
    showError('请先填写 API Base。');
    $('cfg-api-base')?.focus();
    return;
  }
  if (!cfg.model.trim()) {
    showError('请先填写 Model。');
    $('cfg-api-model')?.focus();
    return;
  }
  if (!cfg.apikey.trim() && !cfg.savedApiKey) {
    showError('请先填写 API Key，或先保存已有 API 配置。');
    $('cfg-api-key')?.focus();
    return;
  }
  if (btn) btn.disabled = true;
  if (status) status.textContent = '正在测试 API 响应…';
  try {
    const result = await bridgeApi.testApiResponse(cfg);
    if (result?.ok === false) throw new Error(result.error || '测试响应失败');
    const text = String(result?.text || '').trim();
    const snippet = text.length > 120 ? `${text.slice(0, 120)}…` : text;
    const elapsed = Number.isFinite(result?.elapsedMs) ? `${result.elapsedMs}ms` : '耗时未知';
    if (status) status.textContent = `API 响应正常：${result?.model || cfg.model} · ${elapsed} · ${snippet || '无文本'}`;
  } catch (err) {
    addDiagnostic('error', '测试 API 响应失败', err);
    if (status) status.textContent = '测试响应失败：' + (err.message || err);
    showError('测试响应失败：' + (err.message || err));
  } finally {
    if (btn) btn.disabled = false;
  }
}

function normalizePluginsPayload(result) {
  return {
    plugins: Array.isArray(result?.plugins) ? result.plugins : [],
    diagnostics: Array.isArray(result?.diagnostics) ? result.diagnostics : [],
    settingsPaths: result?.settingsPaths && typeof result.settingsPaths === 'object' ? result.settingsPaths : {},
  };
}

function setPluginStatus(message) {
  const status = $('plugin-status');
  if (status) status.textContent = String(message || '');
}

function pluginScopeLabel(scope) {
  return scope === 'project' ? '项目' : 'Agent';
}

function pluginSourceTypeLabel(type) {
  if (type === 'npm') return 'npm';
  if (type === 'git') return 'Git';
  return '本地';
}

function pluginResourceText(item) {
  const labels = {
    extensions: '扩展',
    skills: '技能',
    prompts: 'Prompt',
    themes: '主题',
  };
  const resources = item.resources || {};
  const active = item.activeResources || {};
  const parts = Object.entries(labels).flatMap(([key, label]) => {
    const total = Number(resources[key] || 0);
    const activeCount = Number(active[key] || 0);
    return total > 0 ? [`${label} ${activeCount}/${total}`] : [];
  });
  const desktopUi = item.desktopUi || {};
  const desktopUiCount = Number(desktopUi.styles || 0) + Number(desktopUi.scripts || 0);
  if (desktopUiCount > 0) parts.push(`会话 UI ${desktopUiCount}`);
  return parts.length ? parts : ['未发现 Pi 资源'];
}

function refreshDesktopUiPlugins() {
  const refresh = window.SecHeurDesktopPlugins?.refresh;
  if (typeof refresh !== 'function') return;
  refresh({ force: true }).catch((err) => addDiagnostic('warn', '刷新 Desktop UI 插件失败', err));
}

function pluginDescription(item) {
  return [
    item.description,
    item.version ? `v${item.version}` : '',
    item.installed ? '已安装' : '安装缺失',
    item.filtered ? '资源筛选' : '',
  ].filter(Boolean).join(' · ');
}

function unifiedPluginStatusText(item) {
  if (item.available === false) return '组件不可用';
  if (item.required) return '系统必需 · 随 Agent 启动';
  if (item.reason === 'runtime-managed') return '运行时托管（只读）';
  if (item.reason === 'disabled-by-config') return '配置为关闭（只读）';
  if (item.filtered) return '资源已被筛选';
  return item.configuredEnabled === false ? '已停用' : '已启用 · 新建或重载会话后生效';
}

function createUnifiedPluginItemRow(item) {
  const input = setDataset(createEl('input'), {
    pluginCatalogToggle: '1',
    pluginKey: item.key,
  });
  input.type = 'checkbox';
  input.checked = item.configuredEnabled !== false;
  input.disabled = state.pluginBusy || item.available === false || item.mutable === false || item.actions?.toggle === false;
  input.title = item.available === false
    ? '组件不可用'
    : item.required
      ? '系统必需组件不能停用'
      : item.mutable === false
        ? '该内置组件由运行时托管，当前只读'
        : item.configuredEnabled === false ? '启用插件' : '停用插件';
  input.setAttribute('aria-label', `${item.configuredEnabled === false ? '启用' : '停用'}插件 ${item.name}`);

  const title = appendChildren(
    createEl('div', 'registry-item-title'),
    createEl('span', '', item.name || item.source || item.id),
    createEl('span', 'registry-pill', item.kind === 'builtin' ? '内置' : pluginSourceTypeLabel(item.sourceType)),
    createEl('span', 'registry-pill', item.kind === 'builtin' ? (item.category || '组件') : pluginScopeLabel(item.scope))
  );
  if (item.required) title.appendChild(createEl('span', 'registry-pill', '系统必需'));

  const resourceList = createEl('div', 'plugin-resource-list');
  const resourceTexts = item.kind === 'builtin'
    ? (Array.isArray(item.capabilities) && item.capabilities.length ? item.capabilities : ['内置能力'])
    : pluginResourceText(item);
  for (const text of resourceTexts) resourceList.appendChild(createEl('span', '', text));

  const dependencyText = Array.isArray(item.requires) && item.requires.length
    ? ` · 依赖：${item.requires.join('、')}`
    : '';
  const description = item.kind === 'builtin'
    ? [item.description, unifiedPluginStatusText(item)].filter(Boolean).join(' · ')
    : pluginDescription(item);
  const sourceText = item.kind === 'builtin'
    ? `${item.id}${dependencyText}`
    : (item.source || '');
  const main = appendChildren(
    createEl('div', 'registry-item-main'),
    title,
    createEl('div', 'registry-item-desc', description),
    resourceList,
    createEl('div', 'registry-item-source', sourceText)
  );
  if (Array.isArray(item.diagnostics) && item.diagnostics.length) {
    main.appendChild(createEl('div', 'plugin-diagnostic', item.diagnostics.join(' · ')));
  }

  const actions = createEl('div', 'registry-item-actions');
  if (item.kind === 'pi') {
    const actionValues = { pluginSource: item.source, pluginScope: item.scope };
    actions.append(
      createSmallActionButton('复制源', { ...actionValues, pluginAction: 'copy' }, state.pluginBusy),
      createSmallActionButton('打开位置', { ...actionValues, pluginAction: 'open' }, state.pluginBusy || !item.actions?.open),
      createSmallActionButton('更新', { ...actionValues, pluginAction: 'update' }, state.pluginBusy || !item.actions?.update),
      createSmallActionButton('卸载', { ...actionValues, pluginAction: 'remove' }, state.pluginBusy || !item.actions?.remove)
    );
  }
  const rowClass = `registry-item plugin-item${item.kind === 'builtin' ? ' builtin-plugin-item' : ''}${item.available === false ? ' is-missing' : ''}`;
  return appendChildren(createEl('div', rowClass), input, main, actions);
}

function renderPlugins() {
  const list = $('plugins-list');
  const count = $('plugins-list-count');
  if (!list) return;
  const allItems = Array.isArray(state.plugins?.plugins) ? state.plugins.plugins : [];
  const query = String(state.pluginFilter || '').trim().toLowerCase();
  const items = query
    ? allItems.filter((item) => JSON.stringify(item).toLowerCase().includes(query))
    : allItems;
  if (count) {
    count.textContent = query ? `插件：${items.length} / ${allItems.length} 个` : `插件：${allItems.length} 个`;
  }
  list.textContent = '';
  if (!items.length) {
    list.appendChild(createEmptyState(query ? '没有匹配的插件。' : '没有发现任何插件。'));
  } else {
    for (const item of items) list.appendChild(createUnifiedPluginItemRow(item));
  }
  const settingsPaths = state.plugins?.settingsPaths || {};
  renderSourceNote(
    'plugins-source-paths',
    '插件设置',
    [settingsPaths.internal, settingsPaths.user, settingsPaths.project].filter(Boolean),
    '未找到插件设置路径。'
  );
}

function setPluginBusy(busy) {
  state.pluginBusy = !!busy;
  const install = $('install-plugin');
  const reload = $('reload-plugins');
  if (install) install.disabled = state.pluginBusy;
  if (reload) reload.disabled = state.pluginBusy;
  renderPlugins();
}

function applyPluginSnapshot(result, message) {
  state.plugins = normalizePluginsPayload(result);
  renderPlugins();
  const diagnosticCount = state.plugins.diagnostics.length;
  const reloadCount = Number(result?.runtimeReloadPending || 0);
  if (reloadCount > 0) invalidateSlashCommandCaches();
  const details = [
    diagnosticCount ? `${diagnosticCount} 条诊断` : '',
    reloadCount ? `${reloadCount} 个会话等待重载` : '',
  ].filter(Boolean);
  setPluginStatus(`${message}${details.length ? ` · ${details.join(' · ')}` : ''}`);
}

async function loadPlugins() {
  if (state.pluginBusy) return;
  setPluginBusy(true);
  setPluginStatus('正在读取插件…');
  try {
    const result = await bridgeApi.listPluginCatalog();
    if (result?.ok === false) throw new Error(result.error || '读取失败');
    applyPluginSnapshot(result, `已读取 ${Array.isArray(result?.plugins) ? result.plugins.length : 0} 个插件`);
  } catch (err) {
    state.plugins = normalizePluginsPayload(null);
    renderPlugins();
    setPluginStatus('插件读取失败：' + (err.message || err));
    addDiagnostic('warn', '加载插件目录失败', err);
  } finally {
    setPluginBusy(false);
  }
}

async function installPluginFromSettings() {
  const sourceInput = $('cfg-plugin-source');
  const source = sourceInput?.value?.trim() || '';
  const scope = $('cfg-plugin-scope')?.value || 'user';
  if (!source) {
    showError('请输入 npm、Git 或本地安装源。');
    sourceInput?.focus();
    return;
  }
  if (state.pluginBusy) return;
  setPluginBusy(true);
  setPluginStatus('正在安装插件…');
  try {
    const result = await bridgeApi.installPlugin(source, scope);
    if (result?.ok === false) throw new Error(result.error || '安装失败');
    const catalog = await bridgeApi.listPluginCatalog();
    if (catalog?.ok === false) throw new Error(catalog.error || '刷新插件目录失败');
    applyPluginSnapshot(catalog, '插件已安装');
    refreshDesktopUiPlugins();
    if (sourceInput) sourceInput.value = '';
  } catch (err) {
    setPluginStatus('插件安装失败：' + (err.message || err));
    addDiagnostic('error', '安装 Pi 插件失败', err);
    showError('安装插件失败：' + (err.message || err));
  } finally {
    setPluginBusy(false);
  }
}

function findPlugin(source, scope) {
  const items = Array.isArray(state.plugins?.plugins) ? state.plugins.plugins : [];
  return items.find((item) => item.source === source && item.scope === scope) || null;
}

function findCatalogPlugin(key) {
  const items = Array.isArray(state.plugins?.plugins) ? state.plugins.plugins : [];
  return items.find((item) => item.key === key) || null;
}

async function setCatalogPluginEnabled(key, enabled) {
  const item = findCatalogPlugin(key);
  if (!item) throw new Error('没有找到该插件');
  if (item.mutable === false || item.actions?.toggle === false) throw new Error('该内置组件当前为只读');
  if (state.pluginBusy) throw new Error('另一个插件操作正在执行');
  setPluginBusy(true);
  setPluginStatus(`正在${enabled ? '启用' : '停用'}插件…`);
  try {
    const result = await bridgeApi.setCatalogPluginEnabled(item, enabled);
    if (result?.ok === false) throw new Error(result.error || '保存失败');
    applyPluginSnapshot(result, `插件已${enabled ? '启用' : '停用'}`);
    if (item.kind === 'pi') refreshDesktopUiPlugins();
  } finally {
    setPluginBusy(false);
  }
}

async function handlePluginAction(action, source, scope) {
  const item = findPlugin(source, scope);
  if (!item) throw new Error('没有找到该插件');
  if (action === 'copy') {
    await copyText(item.source);
    setPluginStatus('插件安装源已复制');
    return;
  }
  if (action === 'open') {
    if (!item.installedPath) throw new Error('插件没有可打开的安装路径');
    const result = await bridgeApi.rpc('app/path/open', { path: item.installedPath });
    if (result?.ok === false) throw new Error(result.error || '打开失败');
    setPluginStatus('已打开插件安装位置');
    return;
  }
  if (action === 'remove' && !window.confirm(`卸载 Pi 插件 ${item.name}？`)) return;
  if (state.pluginBusy) throw new Error('另一个插件操作正在执行');
  setPluginBusy(true);
  setPluginStatus(action === 'update' ? '正在更新插件…' : '正在卸载插件…');
  try {
    const result = action === 'update'
      ? await bridgeApi.updatePlugin(source, scope)
      : await bridgeApi.removePlugin(source, scope);
    if (result?.ok === false) throw new Error(result.error || `${action === 'update' ? '更新' : '卸载'}失败`);
    const catalog = await bridgeApi.listPluginCatalog();
    if (catalog?.ok === false) throw new Error(catalog.error || '刷新插件目录失败');
    applyPluginSnapshot(catalog, action === 'update' ? '插件已更新' : '插件已卸载');
    refreshDesktopUiPlugins();
  } finally {
    setPluginBusy(false);
  }
}

function registryLabel(kind, count) {
  if (kind === 'mcpServers') return `MCP：${count} 个`;
  if (kind === 'skills') return `技能：${count} 个`;
  if (kind === 'agents') return `Agent：${count} 个`;
  return `工具：${count} 个`;
}

function registryEmptyText(kind) {
  if (kind === 'mcpServers') return '扫描路径里还没有 MCP 配置。';
  if (kind === 'skills') return '默认技能目录里还没有 SKILL.md。';
  if (kind === 'agents') return '还没有读取到自定义 Agent。内置 Agent 会默认显示。';
  return '没有读取到工具 schema。';
}

function registryKindText(kind) {
  if (kind === 'mcpServers') return 'MCP';
  if (kind === 'skills') return '技能';
  if (kind === 'agents') return 'Agent';
  return '工具';
}

function registryItemSource(item) {
  return item.sourcePath || item.path || item.source || '';
}

function registryItemOpenPath(item) {
  return item.openPath || item.sourcePath || item.path || '';
}

function normalizedRegistryPath(item) {
  return registryItemSource(item).replace(/\\/g, '/');
}

function isProjectOwnedRegistryItem(kind, item) {
  const sourcePath = normalizedRegistryPath(item);
  if (kind === 'mcpServers') return sourcePath.includes('/.secheur-agent/mcp.json');
  if (kind === 'skills') return sourcePath.includes('/.secheur-agent/skills/');
  if (kind === 'agents') return item.source !== 'builtin' && sourcePath.includes('/.secheur-agent/agents/');
  return false;
}

function registryPillText(kind, item) {
  if (kind === 'tools' && item.deferred) return '延迟加载';
  if (kind === 'skills') return item.context === 'fork' ? 'fork' : 'inline';
  if (kind === 'agents') return item.source === 'builtin' ? '内置' : '项目';
  return kind === 'mcpServers' ? (item.transport || (item.url ? 'http' : 'stdio')) : 'skill';
}

function registryDescription(kind, item) {
  if (kind === 'mcpServers') {
    return [item.url || item.command, Array.isArray(item.args) ? item.args.join(' ') : '', item.path].filter(Boolean).join(' · ');
  }
  if (kind === 'skills') {
    return [item.description || '无描述', item.sourcePath || item.path || item.source].filter(Boolean).join(' · ');
  }
  if (kind === 'agents') {
    const tools = Array.isArray(item.allowedTools) && item.allowedTools.length ? `工具：${item.allowedTools.join(', ')}` : '';
    return [item.description, item.whenToUse, tools].filter(Boolean).join(' · ') || '无描述';
  }
  return item.description || item.path || item.source || '无描述';
}

function registryActions(kind, item, sourcePath, openPath) {
  const projectOwned = isProjectOwnedRegistryItem(kind, item);
  const actions = [
    createSmallActionButton('复制路径', { registryAction: 'copy-path', registryKind: kind, registryName: item.name }, !sourcePath),
    createSmallActionButton('打开位置', { registryAction: 'open-path', registryKind: kind, registryName: item.name }, !openPath || openPath === 'virtual'),
  ];
  if (kind === 'mcpServers') {
    actions.unshift(createSmallActionButton('编辑', { registryAction: 'edit-mcp', registryKind: kind, registryName: item.name }));
    actions.push(createSmallActionButton('删除', { registryAction: 'delete-mcp', registryKind: kind, registryName: item.name }, !projectOwned));
  } else if (kind === 'skills') {
    actions.unshift(createSmallActionButton('编辑', { registryAction: 'edit-skill', registryKind: kind, registryName: item.name }));
    actions.push(createSmallActionButton('删除', { registryAction: 'delete-skill', registryKind: kind, registryName: item.name }, !projectOwned));
  } else if (kind === 'agents') {
    actions.unshift(createSmallActionButton(item.source === 'builtin' ? '复制' : '编辑', { registryAction: 'edit-agent', registryKind: kind, registryName: item.name }));
    actions.push(createSmallActionButton('删除', { registryAction: 'delete-agent', registryKind: kind, registryName: item.name }, !projectOwned));
  }
  return actions;
}

function createRegistryItemRow(kind, item) {
  const sourcePath = registryItemSource(item);
  const openPath = registryItemOpenPath(item);
  const input = setDataset(createEl('input'), { registryKind: kind, registryName: item.name });
  input.type = 'checkbox';
  input.checked = item.enabled !== false;

  const title = appendChildren(
    createEl('div', 'registry-item-title'),
    createEl('span', '', item.name),
    createEl('span', 'registry-pill', registryPillText(kind, item))
  );
  const main = appendChildren(
    createEl('div', 'registry-item-main'),
    title,
    createEl('div', 'registry-item-desc', registryDescription(kind, item)),
    createEl('div', 'registry-item-source', sourcePath || '无来源路径')
  );
  const actions = appendChildren(
    createEl('div', 'registry-item-actions'),
    ...registryActions(kind, item, sourcePath, openPath)
  );
  return appendChildren(createEl('div', 'registry-item'), input, main, actions);
}

function renderRegistryList(kind, elementId, countId) {
  const el = $(elementId);
  const countEl = $(countId);
  if (!el) return;
  const allItems = Array.isArray(state.registry?.[kind]) ? state.registry[kind] : [];
  const query = (state.registryFilters[kind] || '').trim().toLowerCase();
  const items = query
    ? allItems.filter((item) => JSON.stringify(item).toLowerCase().includes(query))
    : allItems;
  if (countEl) {
    countEl.textContent = query
      ? `${registryLabel(kind, items.length)} / 共 ${allItems.length} 个`
      : registryLabel(kind, allItems.length);
  }
  el.textContent = '';
  if (!items.length) {
    el.appendChild(createEmptyState(registryEmptyText(kind)));
    return;
  }
  for (const item of items) {
    el.appendChild(createRegistryItemRow(kind, item));
  }
}

function renderRegistry() {
  renderRegistryList('mcpServers', 'mcp-registry-list', 'mcp-list-count');
  renderRegistryList('skills', 'skills-registry-list', 'skills-list-count');
  renderRegistryList('agents', 'agents-registry-list', 'agents-list-count');
  renderRegistryList('tools', 'tools-registry-list', 'tools-list-count');
  renderRegistrySources();
}

function renderSourceNote(elementId, label, paths, fallback) {
  const el = $(elementId);
  if (!el) return;
  const values = Array.isArray(paths) ? paths.filter(Boolean) : (paths ? [paths] : []);
  el.textContent = values.length ? `${label}：${values.join(' · ')}` : fallback;
}

function renderRegistrySources() {
  const sources = state.registry?.sources || {};
  renderSourceNote('mcp-source-paths', '扫描目录', sources.mcpConfigPaths, '未发现项目级 MCP 配置文件。');
  renderSourceNote('skills-source-paths', 'Skill 扫描目录', sources.skillDirs, '未发现默认技能目录。');
  renderSourceNote('agents-source-paths', 'Agent 目录', sources.agentDir, '未发现 Agent 目录。');
  renderSourceNote('tools-source-paths', '工具 schema', sources.toolSchemaPath, '未发现工具 schema。');
}

function normalizeRegistryPayload(result) {
  return {
    mcpServers: Array.isArray(result?.mcpServers) ? result.mcpServers : [],
    skills: Array.isArray(result?.skills) ? result.skills : [],
    agents: Array.isArray(result?.agents) ? result.agents : [],
    tools: Array.isArray(result?.tools) ? result.tools : [],
    sources: result?.sources || {},
  };
}

async function loadRegistry() {
  try {
    const result = await bridgeApi.listRegistry();
    state.registry = normalizeRegistryPayload(result);
    renderRegistry();
  } catch (err) {
    addDiagnostic('warn', '加载 MCP/技能/工具列表失败', err);
    state.registry = normalizeRegistryPayload(null);
    renderRegistry();
  }
}

function findRegistryItem(kind, name) {
  const items = Array.isArray(state.registry?.[kind]) ? state.registry[kind] : [];
  return items.find((item) => item.name === name) || null;
}

function normalizeSettingsSection(section) {
  const requested = section || 'general';
  const exists = [...document.querySelectorAll('.settings-section-panel')]
    .some((panel) => panel.dataset.settingsPanel === requested);
  return exists ? requested : 'general';
}

function setSettingsSection(section) {
  const next = normalizeSettingsSection(section || state.activeSettingsSection || 'general');
  state.activeSettingsSection = next;
  document.querySelectorAll('.settings-nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.settingsSection === next);
  });
  document.querySelectorAll('.settings-section-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.settingsPanel === next);
  });
  renderDiagnostics();
}

function renderJudgeModelProfileOptions(selected = '') {
  const select = $('cfg-judge-model-profile');
  if (!select) return;
  select.textContent = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '使用主 Agent 默认模型';
  select.appendChild(placeholder);
  const profiles = Array.isArray(state.modelProfiles) ? state.modelProfiles : [];
  for (const profile of profiles) {
    const opt = document.createElement('option');
    opt.value = String(modelProfileId(profile));
    opt.textContent = modelProfileLabel(profile);
    select.appendChild(opt);
  }
  if (selected && ![...select.options].some((opt) => opt.value === String(selected))) {
    const opt = document.createElement('option');
    opt.value = String(selected);
    opt.textContent = `模型 ${selected}`;
    select.appendChild(opt);
  }
  select.value = selected ? String(selected) : '';
}

function hydrateJudgeControls(cfg) {
  const judge = (cfg && cfg.judge) || {};
  document.querySelectorAll('[data-setting="judge"]').forEach((el) => {
    const key = el.dataset.judgeKey;
    if (!key) return;
    if (el.type === 'checkbox') {
      el.checked = !!judge[key];
    } else if (key === 'model_profile') {
      renderJudgeModelProfileOptions(judge[key] || '');
    } else if (el.tagName === 'SELECT') {
      el.value = judge[key] != null ? String(judge[key]) : '';
    } else if (key === 'every_n_turns') {
      el.value = judge[key] != null ? String(judge[key]) : '5';
    } else if (key === 'max_history_messages') {
      el.value = judge[key] != null ? String(judge[key]) : '8';
    } else {
      el.value = judge[key] != null ? String(judge[key]) : '';
    }
  });
}

function readJudgeControls(cfg) {
  const judge = {};
  document.querySelectorAll('[data-setting="judge"]').forEach((el) => {
    const key = el.dataset.judgeKey;
    if (!key) return;
    if (el.type === 'checkbox') {
      judge[key] = !!el.checked;
    } else if (key === 'model_profile') {
      judge[key] = el.value || null;
    } else if (key === 'every_n_turns') {
      const parsed = parseInt(el.value, 10);
      judge[key] = Number.isFinite(parsed) ? parsed : 5;
    } else if (key === 'max_history_messages') {
      const parsed = parseInt(el.value, 10);
      judge[key] = Number.isFinite(parsed) ? parsed : 8;
    } else {
      judge[key] = el.value;
    }
  });
  cfg.judge = judge;
}

async function hydrateSettingsForm() {
  renderThemePicker();
  const cfg = getActiveConfig();
  const sess = state.sessions.get(state.activeId);
  hydrateSettingControls(cfg);
  hydrateJudgeControls(cfg);
  setThemeSelection(cfg.theme || 'white');
  try {
    const status = await bridgeApi.checkStatus();
    const cwd = $('cfg-cwd');
    if (cwd) cwd.value = sess?.cwd || projectRootFromPayload(status) || cfg.projectRoot || '';
  } catch (_) {
    const cwd = $('cfg-cwd');
    if (cwd) cwd.value = sess?.cwd || cfg.projectRoot || '';
  }
}

function openSettings(section) {
  renderModelOptions();
  hydrateSettingsForm();
  setSettingsSection(section || state.activeSettingsSection || 'general');
  settingsModal.classList.remove('hidden');
  settingsModal.setAttribute('aria-hidden', 'false');
  loadModelProfiles();
  loadApiConfig();
  loadRegistry();
  loadPlugins();
}
function closeSettings() {
  settingsModal.classList.add('hidden');
  settingsModal.setAttribute('aria-hidden', 'true');
}

async function saveSettings() {
  const saveBtn = $('save-settings');
  saveBtn.disabled = true;
  try {
    const sess = state.sessions.get(state.activeId);
    if (!sess) throw new Error('没有活动会话');
    const cfg = sess.config;
    readSettingControls(cfg);
    readJudgeControls(cfg);
    cfg.permissionMode = cfg.permissionMode || 'default';
    applyTheme();
    applyUiPreferences();
    renderComposerControls();
    await persistDesktopConfig(cfg);
    await loadRegistry();
    closeSettings();
  } catch (err) {
    showError('保存设置失败：' + (err.message || err));
  } finally {
    saveBtn.disabled = false;
  }
}

async function applyRuntimeSettings() {
  await saveSettings();
}

async function setComposerPermissionMode(mode) {
  const sess = state.sessions.get(state.activeId);
  if (!sess) return;
  if (getSessionRuntime(sess)?.busy) {
    flashComposerNotice('当前任务运行中，停止后可切换权限模式。');
    renderComposerControls();
    return;
  }
  const next = COMPOSER_PERMISSION_LABELS[mode] ? mode : 'default';
  const previous = sess.config.permissionMode || 'default';
  sess.config.permissionMode = next;
  renderComposerControls();
  try {
    const sessionId = await ensureBridgeSession(sess);
    await bridgeApi.rpc('session/permission-mode', { sessionId, mode: next });
    await persistDesktopConfig(sess.config);
  } catch (err) {
    sess.config.permissionMode = previous;
    renderComposerControls();
    await persistDesktopConfig(sess.config).catch(() => {});
    showError('切换权限模式失败：' + (err.message || err));
  }
}

async function setComposerModel(llmNoValue) {
  const sess = state.sessions.get(state.activeId);
  if (!sess) return;
  const runtime = getSessionRuntime(sess);
  const llmNo = Math.max(0, parseInt(llmNoValue, 10) || 0);
  const previous = Math.max(0, parseInt(sess.config.llmNo || '0', 10) || 0);
  const previousValue = sess.composerModelValue || String(previous);
  const previousApiModelValue = sess.composerApiModelValue || '';
  sess.config.llmNo = llmNo;
  sess.composerModelValue = String(llmNo);
  syncComposerApiModelFromSelectedProfile(sess);
  state.apiModels = [];
  renderModelOptions();
  renderComposerControls();
  try {
    let result = null;
    if (sess.bridgeSessionId) {
      const attemptedSessionId = sess.bridgeSessionId;
      try {
        result = await bridgeApi.rpc('session/model', { sessionId: attemptedSessionId, llmNo });
      } catch (err) {
        if (isBridgeSessionNotFoundError(err)) {
          clearStaleBridgeSession(sess, err, attemptedSessionId);
          result = await bridgeApi.rpc('session/model', { sessionId: await ensureBridgeSession(sess), llmNo });
        } else {
          throw err;
        }
      }
      if (result?.error) throw new Error(result.error.message || result.error);
    }
    if (result?.wasRunning && runtime) {
      runtime.busy = false;
      runtime.currentTurnEl = null;
      runtime.assistantDraft = null;
      runtime.taskStartedAt = 0;
      runtime.lastAssistantActivityAt = 0;
      runtime.stalledNoticeShown = false;
      runtime.currentStageText = '';
      runtime.currentStageKind = '';
      flashComposerNotice('已切换模型，当前任务已停止。');
    }
    await persistDesktopConfig(sess.config);
    await refreshComposerApiModels({ silent: true });
    renderComposerActivity();
    renderSendButtonState();
  } catch (err) {
    sess.config.llmNo = previous;
    sess.composerModelValue = previousValue;
    sess.composerApiModelValue = previousApiModelValue;
    renderModelOptions();
    renderComposerControls();
    await persistDesktopConfig(sess.config).catch(() => {});
    showError('切换模型失败：' + (err.message || err));
  }
}

async function setComposerApiModel(modelId) {
  const sess = state.sessions.get(state.activeId);
  if (!sess) return;
  const context = composerApiContext(sess);
  const currentApi = context.config || {};
  if (!context.hasApiKey || !currentApi.name || !currentApi.apibase) {
    renderComposerControls();
    showError('请先在设置 → API 保存可用的 API 配置。');
    return;
  }
  const previousApiConfig = state.apiConfig ? JSON.parse(JSON.stringify(state.apiConfig)) : null;
  const previousValue = sess.composerApiModelValue || String(currentApi.model || '');
  const nextValue = String(modelId || '').trim();
  if (!nextValue) {
    renderComposerControls();
    return;
  }
  sess.composerApiModelValue = nextValue;
  renderApiModelOptions();
  renderComposerControls();
  const cfg = {
    ...currentApi,
    model: nextValue,
    apikey: '',
    activate: true,
  };
  try {
    const result = await bridgeApi.saveApiConfig(cfg);
    if (result?.ok === false) throw new Error(result.error || '保存失败');
    state.apiConfig = result;
    await loadModelProfiles();
    const llmNo = Math.max(0, parseInt(sess.config.llmNo || '0', 10) || 0);
    if (sess.bridgeSessionId) {
      await bridgeApi.rpc('session/model', { sessionId: sess.bridgeSessionId, llmNo });
    }
    await persistDesktopConfig(sess.config);
    await refreshComposerApiModels({ silent: true });
    renderApiConfigForm(state.apiConfig);
    sess.composerApiModelValue = nextValue;
    renderApiModelOptions();
    renderComposerControls();
    flashComposerNotice(`已切换 API 模型：${nextValue}`);
  } catch (err) {
    state.apiConfig = previousApiConfig;
    sess.composerApiModelValue = previousValue;
    renderApiModelOptions();
    renderComposerControls();
    showError('切换 API 模型失败：' + (err.message || err));
  }
}

async function runMemorySearch() {
  await saveSettings();
  const query = $('cfg-memory-query')?.value?.trim() || '';
  if (!query) {
    showSystem('请输入 memory search query。');
    return;
  }
  closeSettings();
  await sendPrompt(`请调用 memory_search 搜索：${query}`, []);
}

async function runMcpRefresh() {
  await saveSettings();
  closeSettings();
  await sendPrompt('请调用 mcp_refresh，刷新并列出当前 MCP 工具。', []);
}

async function runSkillFromSettings() {
  await saveSettings();
  const name = $('cfg-skill-name')?.value?.trim() || '';
  const args = $('cfg-skill-args')?.value?.trim() || '';
  if (!name) {
    showSystem('请输入 skill name。');
    return;
  }
  closeSettings();
  const suffix = args ? `，参数：${args}` : '';
  await sendPrompt(`请调用 skill 工具执行 ${name}${suffix}`, []);
}

async function saveApiConfigFromSettings() {
  const btn = $('save-api-config');
  if (btn) btn.disabled = true;
  try {
    const cfg = {
      type: $('cfg-api-type')?.value || 'native_oai',
      name: $('cfg-api-name')?.value || '',
      apibase: $('cfg-api-base')?.value || '',
      model: $('cfg-api-model')?.value || '',
      apikey: $('cfg-api-key')?.value || '',
      proxy: $('cfg-api-proxy')?.value || '',
    };
    if (cfg.type === 'native_oai') {
      cfg.api_mode = $('cfg-api-mode')?.value || 'chat_completions';
    } else {
      cfg.relay_compat_system_prompt = !!$('cfg-api-relay-compat')?.checked;
      cfg.thinking_type = $('cfg-api-thinking')?.value || 'adaptive';
    }
    const result = await bridgeApi.saveApiConfig(cfg);
    if (result?.ok === false) throw new Error(result.error || '保存失败');
    state.apiConfig = result;
    renderApiConfigForm(result);
    await loadModelProfiles();
    await refreshComposerApiModels({ silent: true });
    addDiagnostic('info', 'API 配置已保存', result.mykeyPath);
    showSystem('API 配置已保存，新的会话会使用最新模型配置。');
  } catch (err) {
    showError('保存 API 配置失败：' + (err.message || err));
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteApiProfileFromSettings(name) {
  if (!name) throw new Error('没有找到 API profile 名称');
  if (!window.confirm(`删除 API profile ${name}？`)) return;
  const result = await bridgeApi.deleteApiConfig(name);
  if (result?.ok === false) throw new Error(result.error || '删除失败');
  state.apiConfig = result;
  renderApiConfigForm(result);
  await loadModelProfiles();
  showSystem(`API profile ${name} 已删除。`);
}

function clearMcpConfigForm() {
  ['cfg-mcp-name', 'cfg-mcp-command', 'cfg-mcp-url', 'cfg-mcp-args', 'cfg-mcp-cwd', 'cfg-mcp-env', 'cfg-mcp-headers'].forEach((id) => {
    const el = $(id);
    if (el) el.value = '';
  });
  $('cfg-mcp-name')?.focus();
}

function fillMcpServer(name) {
  const item = findRegistryItem('mcpServers', name);
  if (!item) return;
  const setValue = (id, value) => {
    const el = $(id);
    if (el) el.value = value == null ? '' : String(value);
  };
  setValue('cfg-mcp-name', item.name || '');
  setValue('cfg-mcp-command', item.command || '');
  setValue('cfg-mcp-url', item.url || '');
  setValue('cfg-mcp-args', Array.isArray(item.args) ? item.args.join(' ') : (item.args || ''));
  setValue('cfg-mcp-cwd', item.cwd || '');
  const env = item.env && Object.keys(item.env).length ? JSON.stringify(item.env, null, 2) : '';
  setValue('cfg-mcp-env', env);
  const headers = item.headers && Object.keys(item.headers).length ? JSON.stringify(item.headers, null, 2) : '';
  setValue('cfg-mcp-headers', headers);
}

function readMcpEnv() {
  const raw = $('cfg-mcp-env')?.value?.trim() || '';
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('环境变量 JSON 必须是对象');
  }
  return parsed;
}

function readMcpHeaders() {
  const raw = $('cfg-mcp-headers')?.value?.trim() || '';
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('HTTP Headers JSON 必须是对象');
  }
  return parsed;
}

async function saveMcpConfigFromSettings() {
  const btn = $('save-mcp-config');
  if (btn) btn.disabled = true;
  try {
    const cfg = {
      name: $('cfg-mcp-name')?.value?.trim() || '',
      command: $('cfg-mcp-command')?.value?.trim() || '',
      url: $('cfg-mcp-url')?.value?.trim() || '',
      args: $('cfg-mcp-args')?.value?.trim() || '',
      cwd: $('cfg-mcp-cwd')?.value?.trim() || '',
      env: readMcpEnv(),
      headers: readMcpHeaders(),
    };
    if (!cfg.name) throw new Error('请输入 MCP server 名称');
    if (!cfg.command && !cfg.url) throw new Error('请输入启动命令或 HTTP URL');
    const result = await bridgeApi.saveMcpConfig(cfg);
    if (result?.ok === false) throw new Error(result.error || '保存失败');
    state.registry = normalizeRegistryPayload(result);
    renderRegistry();
    addDiagnostic('info', 'MCP 配置已保存', result.saved?.path || '');
    showSystem(`MCP ${cfg.name} 已保存。`);
  } catch (err) {
    showError('保存 MCP 配置失败：' + (err.message || err));
  } finally {
    if (btn) btn.disabled = false;
  }
}

function clearSkillConfigForm() {
  ['cfg-skill-name', 'cfg-skill-args', 'cfg-skill-description', 'cfg-skill-body'].forEach((id) => {
    const el = $(id);
    if (el) el.value = '';
  });
  const context = $('cfg-skill-context');
  if (context) context.value = 'inline';
  $('cfg-skill-name')?.focus();
}

function fillSkillDefinition(name) {
  const item = findRegistryItem('skills', name);
  if (!item) return;
  const setValue = (id, value) => {
    const el = $(id);
    if (el) el.value = value == null ? '' : String(value);
  };
  setValue('cfg-skill-name', item.name || '');
  setValue('cfg-skill-description', item.description || '');
  setValue('cfg-skill-context', item.context === 'fork' ? 'fork' : 'inline');
  setValue('cfg-skill-body', item.body || '');
}

async function saveSkillConfigFromSettings() {
  const btn = $('save-skill-config');
  if (btn) btn.disabled = true;
  try {
    const cfg = {
      name: $('cfg-skill-name')?.value?.trim() || '',
      description: $('cfg-skill-description')?.value?.trim() || '',
      context: $('cfg-skill-context')?.value || 'inline',
      body: $('cfg-skill-body')?.value?.trim() || '',
    };
    if (!cfg.name) throw new Error('请输入 skill 名称');
    if (!cfg.body) throw new Error('请输入 SKILL.md 正文');
    const result = await bridgeApi.saveSkillConfig(cfg);
    if (result?.ok === false) throw new Error(result.error || '保存失败');
    state.registry = normalizeRegistryPayload(result);
    renderRegistry();
    invalidateSlashCommandCaches();
    addDiagnostic('info', 'Skill 已保存', result.saved?.path || '');
    showSystem(`Skill ${cfg.name} 已保存。`);
  } catch (err) {
    showError('保存 Skill 失败：' + (err.message || err));
  } finally {
    if (btn) btn.disabled = false;
  }
}

function clearAgentConfigForm() {
  ['cfg-agent-name', 'cfg-agent-description', 'cfg-agent-tools', 'cfg-agent-when', 'cfg-agent-body'].forEach((id) => {
    const el = $(id);
    if (el) el.value = '';
  });
  $('cfg-agent-name')?.focus();
}

function fillAgentDefinition(name) {
  const item = findRegistryItem('agents', name);
  if (!item) return;
  const setValue = (id, value) => {
    const el = $(id);
    if (el) el.value = value == null ? '' : String(value);
  };
  setValue('cfg-agent-name', item.name || '');
  setValue('cfg-agent-description', item.description || '');
  setValue('cfg-agent-tools', Array.isArray(item.allowedTools) ? item.allowedTools.join(',') : '');
  setValue('cfg-agent-when', item.whenToUse || '');
  setValue('cfg-agent-body', item.body || '');
}

async function saveAgentConfigFromSettings() {
  const btn = $('save-agent-config');
  if (btn) btn.disabled = true;
  try {
    const cfg = {
      name: $('cfg-agent-name')?.value?.trim() || '',
      description: $('cfg-agent-description')?.value?.trim() || '',
      allowedTools: $('cfg-agent-tools')?.value?.trim() || '',
      whenToUse: $('cfg-agent-when')?.value?.trim() || '',
      body: $('cfg-agent-body')?.value?.trim() || '',
    };
    if (!cfg.name) throw new Error('请输入 Agent 名称');
    if (!cfg.body) throw new Error('请输入 Agent 指令正文');
    const result = await bridgeApi.saveAgentConfig(cfg);
    if (result?.ok === false) throw new Error(result.error || '保存失败');
    state.registry = normalizeRegistryPayload(result);
    renderRegistry();
    addDiagnostic('info', 'Agent 已保存', result.saved?.path || '');
    showSystem(`Agent ${cfg.name} 已保存。`);
  } catch (err) {
    showError('保存 Agent 失败：' + (err.message || err));
  } finally {
    if (btn) btn.disabled = false;
  }
}

function fillApiProfile(name) {
  const profiles = state.apiConfig?.profiles || [];
  const profile = profiles.find((item) => item.name === name);
  if (!profile) return;
  renderApiConfigForm({ ...(state.apiConfig || {}), config: profile.config || {} });
  const status = $('api-config-status');
  if (status) {
    status.textContent = `正在编辑：${profile.name} · ${profile.hasApiKey ? profile.maskedApiKey : '未保存 Key'}`;
  }
}

async function saveRegistryToggle(kind, name, enabled) {
  const payload = { [kind]: { [name]: enabled } };
  const result = await bridgeApi.saveRegistry(payload);
  if (result?.ok === false) throw new Error(result.error || '保存失败');
  state.registry = normalizeRegistryPayload(result);
  renderRegistry();
  if (kind === 'skills') invalidateSlashCommandCaches();
  showSystem(`${registryKindText(kind)} ${name} 已${enabled ? '启用' : '停用'}。`);
}

async function handleRegistryAction(action, kind, name) {
  const item = findRegistryItem(kind, name);
  if (!item) throw new Error('没有找到该条目');
  if (action === 'edit-mcp') {
    fillMcpServer(name);
    setSettingsSection('mcp');
    return;
  }
  if (action === 'edit-skill') {
    fillSkillDefinition(name);
    setSettingsSection('skills');
    return;
  }
  if (action === 'edit-agent') {
    fillAgentDefinition(name);
    setSettingsSection('agents');
    return;
  }
  if (action === 'copy-path') {
    const path = registryItemSource(item);
    if (!path) throw new Error('该条目没有来源路径');
    await copyText(path);
    showSystem(`已复制 ${registryKindText(kind)} ${name} 的路径。`);
    return;
  }
  if (action === 'open-path') {
    const path = registryItemOpenPath(item);
    if (!path || path === 'virtual') throw new Error('该条目没有可打开的位置');
    const result = await bridgeApi.rpc('app/path/open', { path });
    if (result?.ok === false) throw new Error(result.error || '打开失败');
    showSystem(`已打开 ${registryKindText(kind)} ${name} 的位置。`);
    return;
  }
  if (action === 'delete-mcp' || action === 'delete-skill' || action === 'delete-agent') {
    if (!isProjectOwnedRegistryItem(kind, item)) throw new Error('只能删除项目默认目录里的条目');
    if (!window.confirm(`删除 ${registryKindText(kind)} ${name}？`)) return;
    const call = {
      'delete-mcp': () => bridgeApi.deleteMcpConfig(name),
      'delete-skill': () => bridgeApi.deleteSkillConfig(name),
      'delete-agent': () => bridgeApi.deleteAgentConfig(name),
    }[action];
    const result = await call();
    if (result?.ok === false) throw new Error(result.error || '删除失败');
    state.registry = normalizeRegistryPayload(result);
    renderRegistry();
    if (action === 'delete-skill') invalidateSlashCommandCaches();
    showSystem(`${registryKindText(kind)} ${name} 已删除。`);
  }
}

async function applySettingsCommand(command) {
  switch (command) {
    case 'apply-runtime':
      await applyRuntimeSettings();
      break;
    case 'restart-bridge':
      closeSettings();
      await restartBridge();
      break;
    case 'search-skills':
      closeSettings();
      await sendPrompt('请调用 tool_search 搜索当前可用 skill，并按用途分组列出。', []);
      break;
    case 'open-diagnostics':
      openDiagnostics();
      break;
    case 'copy-diagnostics':
      await copyDiagnostics();
      break;
    case 'clear-diagnostics':
      clearDiagnostics();
      break;
    case 'reload-registry':
      await loadRegistry();
      break;
  }
}

async function applySessionAction(action) {
  switch (action) {
    case 'new':
      closeSettings();
      await newSession();
      break;
    case 'clear': {
      const sess = state.sessions.get(state.activeId);
      if (sess) {
        sess.messages = [];
        renderMessages();
      }
      break;
    }
    case 'stop':
      if (await cancelPrompt()) showSystem('已请求停止。');
      break;
    case 'restart':
      closeSettings();
      await restartBridge();
      break;
  }
}

async function ensureBridgeSession(sess, options = {}) {
  if (!sess) throw new Error('没有活动会话。');
  const { forceNew = false } = options || {};
  if (!forceNew && sess.bridgeSessionId) return sess.bridgeSessionId;
  const cwd = sess.cwd || await getCwd();
  const res = await bridgeApi.rpc('session/new', { cwd, mcp_servers: [], ...sessionConfigPayload(sess.config) });
  if (res.error) throw new Error(typeof res.error === 'string' ? res.error : (res.error.message || JSON.stringify(res.error)));
  sess.bridgeSessionId = res.sessionId;
  sess.cwd = cwd;
  void loadSessionSlashCommands(sess, { force: true });
  return sess.bridgeSessionId;
}

async function restartBridge(options = {}) {
  const { remapSessions = false } = options;
  setStatus('warn', 'Restarting…');
  state.bridgeReady = false;
  state.restartingBridge = true;
  if (remapSessions) {
    for (const sess of state.sessions.values()) sess.bridgeSessionId = null;
  }
  state.bridgeNoticeMessage = showSystem('Bridge 正在重启…');
  const bridgeStatus = await bridgeApi.startBridge(getActiveConfig().llmNo || 0);
  state.managedBridge = bridgeStatus?.managedSessions === true;
  window.setTimeout(() => {
    if (state.restartingBridge && !state.bridgeReady && !getActiveSessionRuntime()?.busy) {
      markBridgeReady('Bridge 已就绪。');
      addDiagnostic('warn', 'Bridge 就绪事件超时，已在本地恢复就绪状态');
    }
  }, 2500);
}

// ─── Bridge events ───────────────────────────────────────────────────────
let _bootstrappingSession = false;
async function markBridgeReady(noticeText = 'Bridge 已就绪。') {
  if (state.bridgeReady) return; // already marked ready, prevent double-fire
  state.bridgeReady = true;
  state.restartingBridge = false;
  if (getActiveSessionRuntime()?.busy) setStatus('busy', 'Agent 正在回复…');
  else setStatus('ok', '就绪');
  updateBridgeNotice(noticeText);
  hideError();
  // Restore sessions from bridge (survives page refresh) or create first session
  if (!state.activeId && !_bootstrappingSession) {
    _bootstrappingSession = true;
    const selectionVersion = state.sessionSelectionVersion;
    try {
      // Try to restore existing sessions from bridge
      const listRes = await bridgeApi.rpc('session/list', { includeSolvers: false }).catch(() => null);
      const existingSessions = listRes?.sessions || [];
      if (existingSessions.length > 0) {
        // Restore metadata for every session, but hydrate only the preferred one.
        // The remaining transcripts are loaded when the user opens a session.
        initializeSessionOrder(existingSessions);
        let savedActiveId = '';
        try { savedActiveId = sessionStorage.getItem('secheur:active-session') || ''; } catch (_) {}
        // The bridge's active session is authoritative for the desktop Main Agent
        // entry. A stale saved id (typically an empty "New chat") must not take its
        // place when the page is reloaded.
        const selectableSessions = existingSessions.filter((snapshot) => !shouldIgnoreBridgeSessionSnapshot(snapshot));
        const nonSolverSessions = selectableSessions.filter((snapshot) => (
          String(snapshot?.role || '').toLowerCase() !== 'solver'
        ));
        const snapshotForSessionId = (id) => nonSolverSessions.find(
          (snapshot) => bridgeSessionIdFromPayload(snapshot) === id,
        );
        const preferredBridgeSessionId = bridgeSessionIdFromPayload(
          snapshotForSessionId(listRes?.activeSessionId)
            || snapshotForSessionId(savedActiveId)
            || nonSolverSessions.find((snapshot) => isUntitledSessionTitle(snapshot?.title))
            || nonSolverSessions[0]
            || selectableSessions[0],
        );
        for (const bSess of existingSessions) {
          const sess = upsertLocalSessionForBridgeSession(bSess, bSess.title || 'Restored');
          if (!sess) continue;
          const sid = bSess.id || bSess.sessionId;
          const runtime = getSessionRuntime(sess);
          runtime.busy = bSess.status === 'running' || !!bSess.partial;
          if (String(sid || '') === preferredBridgeSessionId) {
            await hydrateSessionMessages(sess, { limit: SESSION_HISTORY_BOOTSTRAP_LIMIT }).catch((error) => {
              addDiagnostic('warn', '启动时加载当前会话历史失败', error);
            });
          }
        }
        sortSessionsByPosition();
        if (selectionVersion === state.sessionSelectionVersion && !state.activeId) {
          const preferredSession = findSessionByBridgeId(preferredBridgeSessionId);
          if (preferredSession) setActiveSession(preferredSession.id);
        }
      } else if (listRes && !state.managedBridge && selectionVersion === state.sessionSelectionVersion && !state.activeId) {
        await newSession();
      }
    } finally { _bootstrappingSession = false; }
  }
  await refreshPersistedSessions();
  startPersistedSessionRefresh();
  await loadWorklist();
  startWorklistRefresh();
  updateSendButton();
  // Refresh model profiles from bridge (authoritative source)
  loadModelProfiles();
}

bridgeApi.onBridgeReady((status) => {
  state.managedBridge = status?.managedSessions === true;
  if (!state.configLoaded) {
    state.pendingBridgeReadyNotice = 'Bridge 已就绪。';
    return;
  }
  markBridgeReady();
});

bridgeApi.onBridgeMessage(() => {
  // RPC responses are resolved in main; renderer readiness comes from bridge-ready.
});

bridgeApi.onBridgeNotification((msg) => {
  handleNotification(msg);
});

worklistSyncBtn?.addEventListener('click', () => changeWorklist(() => bridgeApi.syncWorklist()));
worklistToggleBtn?.addEventListener('click', () => changeWorklist(() => (
  state.worklist.running ? bridgeApi.stopWorklist() : bridgeApi.startWorklist()
)));

bridgeApi.onBridgeError((err) => {
  console.error('Bridge error:', err);
  addDiagnostic('error', 'Bridge 错误', err);
  setStatus('err', '错误');
  state.bridgeReady = false;
  state.restartingBridge = false;

  if (err.type === 'no-mykey') {
    showError(err.message, '设置', async () => {
      await bridgeApi.openMykeyTemplate();
    }, { skipDiagnostic: true });
  } else if (err.type === 'no-python') {
    showError(err.message, '设置', openSettings, { skipDiagnostic: true });
  } else {
    showError(err.message || 'Bridge 错误', null, null, { skipDiagnostic: true });
  }
});

function bridgeCloseReason(info) {
  return info?.code || info?.reason || 'unknown';
}

bridgeApi.onBridgeClosed((info) => {
  addDiagnostic('warn', 'Bridge 已关闭', info);
  if (state.restartingBridge) {
    setStatus('warn', 'Restarting…');
    return;
  }
  state.bridgeReady = false;
  setStatus('err', `Bridge 已停止（${bridgeCloseReason(info)}）`);
});

bridgeApi.onBridgeLog((text) => {
  console.log('[bridge]', text);
  addDiagnostic('info', 'Bridge 日志', text);
});

// ─── Input handling ──────────────────────────────────────────────────────
newContentBtn?.addEventListener('click', () => scrollToBottom());

messagesEl.addEventListener('scroll', () => {
  if (isNearBottom()) hideNewContentButton();
});

inputEl.addEventListener('input', () => {
  resizeComposerInput();
  saveActiveComposerDraft();
  updateSlashAssist(true);
  updateSendButton();
});

inputEl.addEventListener('scroll', () => {
  if (slashHighlightEl) slashHighlightEl.scrollTop = inputEl.scrollTop;
});

// IME composition fix - triple guard for CJK input methods (macOS especially)
let _imeComposing = false;
inputEl.addEventListener('compositionstart', () => { _imeComposing = true; });
inputEl.addEventListener('compositionend', () => { _imeComposing = false; });

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' && moveSlashSuggestion(1)) {
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowUp' && moveSlashSuggestion(-1)) {
    e.preventDefault();
    return;
  }
  if (e.key === 'Tab' && completeActiveSlashSuggestion()) {
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    const ctx = getSlashContext();
    const matches = ctx ? getSlashMatches(ctx.query) : [];
    const active = matches[slashSuggestionIndex];
    if (active && ctx.commandText !== active.name && completeActiveSlashSuggestion()) {
      e.preventDefault();
      return;
    }
  }
  const sendShortcut = getActiveConfig().composerSendShortcut || 'enter';
  const modSend = e.key === 'Enter' && (e.metaKey || e.ctrlKey);
  const plainSend = e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && sendShortcut === 'enter';
  if (plainSend || (sendShortcut === 'cmd-enter' && modSend)) {
    if (e.isComposing || _imeComposing || e.keyCode === 229) return; // IME active, ignore
    e.preventDefault();
    submitInput();
  } else if (e.key === 'Escape' && !slashAutocompleteEl?.classList.contains('hidden')) {
    e.preventDefault();
    hideSlashAutocomplete();
  } else if (e.key === 'Escape' && getActiveSessionRuntime()?.busy) {
    e.preventDefault();
    cancelPrompt();
  }
});

// ─── Image paste handling ─────────────────────────────────────────────────
const imagePreviews = document.getElementById('image-previews');
const pendingImages = []; // Array of { dataUrl, id }
const pendingFiles = []; // Array of { id, name, type, size, dataUrl }
const FILE_ATTACHMENT_LIMIT = 8 * 1024 * 1024;

function resizeComposerInput() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  if (slashHighlightEl) slashHighlightEl.scrollTop = inputEl.scrollTop;
}

function saveActiveComposerDraft() {
  const sess = state.sessions.get(state.activeId);
  if (!sess) return;
  sess.composerDraft = {
    text: inputEl?.value || '',
    images: pendingImages.map((item) => ({ ...item })),
    files: pendingFiles.map((item) => ({ ...item })),
  };
}

function restoreComposerDraft(sess) {
  const draft = sess?.composerDraft || { text: '', images: [], files: [] };
  inputEl.value = draft.text || '';
  pendingImages.length = 0;
  pendingFiles.length = 0;
  pendingImages.push(...(Array.isArray(draft.images) ? draft.images.map((item) => ({ ...item })) : []));
  pendingFiles.push(...(Array.isArray(draft.files) ? draft.files.map((item) => ({ ...item })) : []));
  resizeComposerInput();
  renderAttachmentPreviews();
  clearSlashAssist();
  updateSendButton();
}

function clearActiveComposerDraft() {
  const sess = state.sessions.get(state.activeId);
  if (sess) sess.composerDraft = { text: '', images: [], files: [] };
}

function formatFileSize(size) {
  const bytes = Number(size || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function attachmentDisplayName(item, fallback = '附件') {
  return String(item?.name || fallback).trim() || fallback;
}

function attachmentTitle(item, fallback = '附件') {
  const name = attachmentDisplayName(item, fallback);
  const size = Number(item?.size || 0);
  return size > 0 ? `${name} · ${formatFileSize(size)}` : name;
}

function attachmentRemoveLabel(kind, item) {
  return `移除${kind}：${attachmentDisplayName(item, kind)}`;
}

function setAttachmentSelectionBusy(busy) {
  state.attachmentSelectionBusy = !!busy;
  if (composerAddBtn) {
    composerAddBtn.disabled = !!busy;
    composerAddBtn.classList.toggle('loading', !!busy);
    const addTitle = busy ? '正在读取附件…' : '添加附件';
    composerAddBtn.title = addTitle;
    composerAddBtn.setAttribute('aria-label', addTitle);
    composerAddBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
  }
  renderComposerActivity();
  renderSendButtonState();
}

inputEl.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const id = `img-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        pendingImages.push({ dataUrl, id, name: file.name || '粘贴的图片', size: file.size || 0 });
        renderAttachmentPreviews();
      };
      reader.readAsDataURL(file);
      break; // handle one image per paste
    }
  }
});

function attachmentId(prefix = 'att') {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function readFileAttachment(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('文件无效'));
    if (file.size > FILE_ATTACHMENT_LIMIT) {
      return reject(new Error(`${file.name} 超过 ${Math.round(FILE_ATTACHMENT_LIMIT / 1024 / 1024)}MB，暂不直接上传。`));
    }
    const reader = new FileReader();
    reader.onload = () => resolve({
      id: attachmentId('file'),
      name: file.name || 'untitled',
      type: file.type || 'application/octet-stream',
      size: file.size || 0,
      dataUrl: String(reader.result || ''),
    });
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name || 'unknown'}`));
    reader.readAsDataURL(file);
  });
}

function readImageAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      dataUrl: reader.result,
      id: attachmentId('img'),
      name: file.name || '图片',
      size: file.size || 0,
    });
    reader.onerror = () => reject(new Error(`读取图片失败：${file.name || 'unknown'}`));
    reader.readAsDataURL(file);
  });
}

async function handleSelectedFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  setAttachmentSelectionBusy(true);
  try {
    for (const file of files) {
      try {
        if (String(file.type || '').startsWith('image/')) {
          pendingImages.push(await readImageAttachment(file));
        } else {
          pendingFiles.push(await readFileAttachment(file));
        }
      } catch (err) {
        addDiagnostic('error', '读取上传文件失败', err);
        showError(err.message || String(err));
      }
    }
  } finally {
    setAttachmentSelectionBusy(false);
  }
  renderAttachmentPreviews();
}

function buildAttachmentPrompt(text, files = pendingFiles) {
  const base = String(text || '').trim();
  return base;
}

function renderAttachmentPreviews() {
  imagePreviews.innerHTML = '';
  for (const img of pendingImages) {
    const wrapper = document.createElement('div');
    wrapper.className = 'image-preview-item';
    wrapper.dataset.imgId = img.id;
    wrapper.title = attachmentTitle(img, '图片');
    wrapper.setAttribute('aria-label', `待发送图片：${attachmentTitle(img, '图片')}`);

    const imgEl = document.createElement('img');
    imgEl.src = img.dataUrl;
    imgEl.alt = img.name || '图片附件';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'remove-img';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', attachmentRemoveLabel('图片', img));
    closeBtn.title = attachmentRemoveLabel('图片', img);
    closeBtn.innerHTML = closeIconSvg(13);
    closeBtn.addEventListener('click', () => {
      const idx = pendingImages.findIndex(i => i.id === img.id);
      if (idx !== -1) pendingImages.splice(idx, 1);
      renderAttachmentPreviews();
    });

    wrapper.appendChild(imgEl);
    wrapper.appendChild(closeBtn);
    imagePreviews.appendChild(wrapper);
  }
  for (const file of pendingFiles) {
    const wrapper = document.createElement('div');
    wrapper.className = 'file-preview-item';
    wrapper.dataset.fileId = file.id;
    wrapper.title = attachmentTitle(file, '文件');
    wrapper.setAttribute('aria-label', `待发送文件：${attachmentTitle(file, '文件')}`);
    wrapper.innerHTML = `
      <span class="file-preview-icon">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <path d="M14 2v6h6"/>
        </svg>
      </span>
      <span class="file-preview-meta">
        <span class="file-preview-name">${escapeHtml(file.name)}</span>
        <span class="file-preview-size">${escapeHtml(formatFileSize(file.size))}</span>
      </span>
    `;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'remove-file';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', attachmentRemoveLabel('文件', file));
    closeBtn.title = attachmentRemoveLabel('文件', file);
    closeBtn.innerHTML = closeIconSvg(13);
    closeBtn.addEventListener('click', () => {
      const idx = pendingFiles.findIndex(item => item.id === file.id);
      if (idx !== -1) pendingFiles.splice(idx, 1);
      renderAttachmentPreviews();
    });
    wrapper.appendChild(closeBtn);
    imagePreviews.appendChild(wrapper);
  }
  state.pendingAttachmentCount = pendingImages.length + pendingFiles.length;
  imagePreviews.style.display = state.pendingAttachmentCount ? 'flex' : 'none';
  saveActiveComposerDraft();
  renderSendButtonState();
}

function renderImagePreviews() {
  renderAttachmentPreviews();
}

function clearPendingImages() {
  pendingImages.length = 0;
  pendingFiles.length = 0;
  renderAttachmentPreviews();
}

function submitInput() {
  const text = inputEl.value.trim();
  if (!text && pendingImages.length === 0 && pendingFiles.length === 0) return;
  const images = [...pendingImages];
  const files = [...pendingFiles];
  const hadAttachments = pendingImages.length > 0 || pendingFiles.length > 0;
  const finalText = buildAttachmentPrompt(text, files);
  const backendText = applyHeuristicLearningPrompt(finalText);
  inputEl.value = '';
  resizeComposerInput();
  clearPendingImages();
  clearActiveComposerDraft();
  clearSlashAssist();
  updateSendButton();

  if (text.startsWith('/') && !hadAttachments) {
    handleSlash(text).catch((err) => {
      showSystem('命令失败：' + (err.message || err));
    });
  } else {
    sendPrompt(finalText, images, files, null, { backendText, displayText: finalText });
  }
}

sendBtn.addEventListener('click', () => {
  const runtime = getActiveSessionRuntime();
  const shouldSubmit = !runtime?.busy || inputEl.value.trim().length > 0 || state.pendingAttachmentCount > 0;
  if (shouldSubmit) {
    submitInput();
  } else {
    cancelPrompt().then((ok) => {
      if (ok) showSystem('已请求停止。');
    });
  }
});

// ─── Buttons ─────────────────────────────────────────────────────────────
$('new-session-btn').addEventListener('click', newSession);
if (composerPermissionSelect) {
  composerPermissionSelect.addEventListener('change', () => {
    setComposerPermissionMode(composerPermissionSelect.value).catch((err) => showError('权限切换失败：' + (err.message || err)));
  });
}
if (composerModelSelect) {
  composerModelSelect.addEventListener('change', () => {
    setComposerModel(composerModelSelect.value).catch((err) => showError('模型切换失败：' + (err.message || err)));
  });
}
if (composerApiModelSelect) {
  composerApiModelSelect.addEventListener('change', () => {
    if (!composerApiModelSelect.value) return;
    setComposerApiModel(composerApiModelSelect.value).catch((err) => showError('API 模型切换失败：' + (err.message || err)));
  });
}
setupComposerPopupSelect(composerModelSelect, '模型');
setupComposerPopupSelect(composerApiModelSelect, 'API 模型');
if (composerAddBtn) {
  composerAddBtn.addEventListener('click', () => {
    if (composerFileInput) composerFileInput.click();
  });
}
if (composerFileInput) {
  composerFileInput.addEventListener('change', () => {
    handleSelectedFiles(composerFileInput.files).finally(() => {
      composerFileInput.value = '';
    });
  });
}
if (tempAgentFloatCloseBtn) tempAgentFloatCloseBtn.addEventListener('click', closeTempSubAgentFloat);
if (tempAgentFloatToggleBtn) tempAgentFloatToggleBtn.addEventListener('click', toggleTempSubAgentFloat);
if (goalPlanToggleEl) goalPlanToggleEl.addEventListener('click', toggleGoalPlanCollapsed);
if (blackboardGraphToggleBtn) blackboardGraphToggleBtn.addEventListener('click', toggleBlackboardGraphCollapsed);
if (blackboardGraphCollapseBtn) blackboardGraphCollapseBtn.addEventListener('click', collapseBlackboardGraph);
if (trajectoryViewerTriggerBtn) trajectoryViewerTriggerBtn.addEventListener('click', openActiveSessionTrajectory);
const sidebarSettingsBtn = $('sidebar-settings-btn');
if (sidebarSettingsBtn) sidebarSettingsBtn.addEventListener('click', () => openSettings('general'));
$('close-settings').addEventListener('click', closeSettings);
$('cancel-settings').addEventListener('click', closeSettings);
$('save-settings').addEventListener('click', saveSettings);
$('save-api-config')?.addEventListener('click', () => saveApiConfigFromSettings());
$('clear-api-config')?.addEventListener('click', clearApiConfigForm);
$('reload-api-config')?.addEventListener('click', () => loadApiConfig());
$('fetch-api-models')?.addEventListener('click', () => fetchApiModelsFromSettings());
$('test-api-response')?.addEventListener('click', () => testApiResponseFromSettings());
$('cfg-api-model-select')?.addEventListener('change', () => {
  const select = $('cfg-api-model-select');
  const input = $('cfg-api-model');
  if (select && input && select.value) input.value = select.value;
});
$('save-mcp-config')?.addEventListener('click', () => saveMcpConfigFromSettings());
$('clear-mcp-config')?.addEventListener('click', clearMcpConfigForm);
$('save-skill-config')?.addEventListener('click', () => saveSkillConfigFromSettings());
$('clear-skill-config')?.addEventListener('click', clearSkillConfigForm);
$('save-agent-config')?.addEventListener('click', () => saveAgentConfigFromSettings());
$('clear-agent-config')?.addEventListener('click', clearAgentConfigForm);
$('install-plugin')?.addEventListener('click', () => installPluginFromSettings());
$('reload-plugins')?.addEventListener('click', () => loadPlugins());
$('cfg-plugin-source')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  installPluginFromSettings();
});
$('error-dismiss').addEventListener('click', hideError);

document.addEventListener('click', (e) => {
  const pluginAction = e.target.closest('[data-plugin-action]');
  if (pluginAction) {
    handlePluginAction(
      pluginAction.dataset.pluginAction,
      pluginAction.dataset.pluginSource,
      pluginAction.dataset.pluginScope
    ).catch((err) => {
      setPluginStatus('插件操作失败：' + (err.message || err));
      showError('插件操作失败：' + (err.message || err));
    });
    return;
  }
  const registryAction = e.target.closest('[data-registry-action]');
  if (registryAction) {
    handleRegistryAction(
      registryAction.dataset.registryAction,
      registryAction.dataset.registryKind,
      registryAction.dataset.registryName
    ).catch((err) => showError('注册表操作失败：' + (err.message || err)));
    return;
  }
  const apiProfileAction = e.target.closest('[data-api-profile-action]');
  if (apiProfileAction) {
    const action = apiProfileAction.dataset.apiProfileAction;
    const name = apiProfileAction.dataset.apiProfileName;
    if (action === 'delete') {
      deleteApiProfileFromSettings(name).catch((err) => showError('删除 API profile 失败：' + (err.message || err)));
    } else {
      fillApiProfile(name);
    }
    return;
  }
  const apiProfile = e.target.closest('[data-api-profile-name]');
  if (apiProfile) {
    fillApiProfile(apiProfile.dataset.apiProfileName);
    return;
  }
  const settingsNav = e.target.closest('[data-settings-section]');
  if (settingsNav) {
    setSettingsSection(settingsNav.dataset.settingsSection);
    return;
  }
  const settingsCommand = e.target.closest('[data-settings-command]');
  if (settingsCommand) {
    applySettingsCommand(settingsCommand.dataset.settingsCommand).catch((err) => showSystem('命令失败：' + (err.message || err)));
    return;
  }
  const sessionAction = e.target.closest('[data-session-action]');
  if (sessionAction) {
    applySessionAction(sessionAction.dataset.sessionAction).catch((err) => showSystem('会话操作失败：' + (err.message || err)));
  }
});

document.addEventListener('change', (e) => {
  const pluginInput = e.target.closest('input[data-plugin-catalog-toggle][data-plugin-key]');
  if (pluginInput) {
    setCatalogPluginEnabled(pluginInput.dataset.pluginKey, pluginInput.checked).catch((err) => {
      pluginInput.checked = !pluginInput.checked;
      setPluginStatus('插件开关保存失败：' + (err.message || err));
      showError('插件开关保存失败：' + (err.message || err));
    });
    return;
  }
  const registryInput = e.target.closest('input[data-registry-kind][data-registry-name]');
  if (!registryInput) return;
  saveRegistryToggle(
    registryInput.dataset.registryKind,
    registryInput.dataset.registryName,
    registryInput.checked
  ).catch((err) => {
    registryInput.checked = !registryInput.checked;
    showError('保存开关状态失败：' + (err.message || err));
  });
});

document.addEventListener('input', (e) => {
  const filterInput = e.target.closest('.registry-filter-input');
  if (!filterInput) return;
  if (filterInput.id === 'plugins-filter') {
    state.pluginFilter = filterInput.value || '';
    renderPlugins();
    return;
  }
  const kindById = {
    'mcp-registry-filter': 'mcpServers',
    'skills-registry-filter': 'skills',
    'agents-registry-filter': 'agents',
    'tools-registry-filter': 'tools',
  };
  const kind = kindById[filterInput.id];
  if (!kind) return;
  state.registryFilters[kind] = filterInput.value || '';
  renderRegistry();
});

$('run-memory-search')?.addEventListener('click', () => runMemorySearch().catch((err) => showSystem('记忆搜索失败：' + (err.message || err))));
$('run-mcp-refresh')?.addEventListener('click', () => runMcpRefresh().catch((err) => showSystem('MCP 刷新失败：' + (err.message || err))));
$('run-skill')?.addEventListener('click', () => runSkillFromSettings().catch((err) => showSystem('技能执行失败：' + (err.message || err))));
$('diagnostics-close')?.addEventListener('click', closeDiagnostics);
$('diagnostics-copy')?.addEventListener('click', copyDiagnostics);
$('diagnostics-clear')?.addEventListener('click', clearDiagnostics);
$('session-log-close')?.addEventListener('click', closeSessionRunLog);

settingsModal.querySelector('.modal-backdrop').addEventListener('click', closeSettings);

// ─── Init ────────────────────────────────────────────────────────────────
(async function init() {
  // Add platform class to body for platform-specific CSS
  const platform = (bridgeApi && bridgeApi.platform) || process.platform || 'unknown';
  document.body.classList.add('platform-' + platform);

  try {
    const saved = await bridgeApi.getConfig();
    Object.assign(state.defaultConfig, saved?.config || saved || {});
    const projectRoot = projectRootFromPayload(saved);
    if (projectRoot) state.defaultConfig.projectRoot = projectRoot;
  } catch (err) {
    addDiagnostic('error', '加载设置失败', err);
    showError('加载设置失败，已使用默认值：' + (err.message || err));
  }
  state.configLoaded = true;
  const planSelect = $('new-session-plan');
	$('new-plan-session-btn')?.addEventListener('click', () => void newSession());
  if (planSelect) {
    try {
      const options = await bridgeApi.rpc('planning/options/get', {});
      if (!['progressive', 'cairn', 'hypothesis', 'artex'].includes(options.engine)) throw new Error('无效的 PLAN 配置');
      state.newSessionPlanningEngine = options.engine;
      planSelect.value = options.engine;
      planSelect.disabled = false;
    } catch (error) {
      planSelect.options[0].textContent = '后端暂不支持';
      $('new-session-plan-status').textContent = '当前后端暂不支持 PLAN 切换';
      addDiagnostic('warn', '加载 PLAN 选项失败', error);
    }
    planSelect.addEventListener('change', async () => {
      const previous = state.newSessionPlanningEngine;
      planSelect.disabled = true;
      state.planningSelectionSaving = true;
      try {
        const saved = await bridgeApi.rpc('planning/options/save', { engine: planSelect.value });
        state.newSessionPlanningEngine = saved.engine;
        planSelect.value = saved.engine;
      } catch (error) {
        planSelect.value = previous || '';
        showError('保存 PLAN 失败：' + (error.message || error));
      } finally {
        planSelect.disabled = false;
        state.planningSelectionSaving = false;
        renderComposerControls();
      }
    });
  }
  if (state.pendingBridgeReadyNotice) {
    const notice = state.pendingBridgeReadyNotice;
    state.pendingBridgeReadyNotice = null;
    markBridgeReady(notice);
  }
  applyTheme();
  applyUiPreferences();
  setupBenchmarkDashboardShortcut();
  initHeuristicLearningToggle();
  initWebVerbsToggle();
  ensureChatView();
  await loadModelProfiles();
  await loadApiConfig();
  renderComposerControls();
  updateSendButton();
  inputEl.focus();
})();
