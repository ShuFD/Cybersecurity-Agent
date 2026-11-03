import { useVirtualizer } from "@tanstack/react-virtual";
import DOMPurify from "dompurify";
import {
	Activity,
	AlertCircle,
	Bot,
	ChevronDown,
	ChevronRight,
	CircleStop,
	Clock3,
	Command,
	ExternalLink,
	LayoutList,
	MessageSquare,
	Moon,
	PanelLeft,
	Plus,
	Puzzle,
	RefreshCw,
	Route,
	Send,
	Settings,
	ShieldCheck,
	Sun,
	TerminalSquare,
	Users,
	Wifi,
	X,
} from "lucide-react";
import { marked } from "marked";
import { type FormEvent, type JSX, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import logoUrl from "./assets/secheur-agent-logo.png";
import type { PlanningEngine, PromptOptions } from "./bridge/client.ts";
import {
	buildConversationRows,
	type ConversationToolRecord,
	conversationToolSummary,
	splitAssistantContent,
} from "./conversation-trace.ts";
import { ExplorationGraphView } from "./ExplorationGraphView.tsx";
import {
	createDefaultClient,
	sessionStore,
	useSessionMessages,
	useSessionOperation,
	useSessionPartial,
	useSessionPermissions,
	useSessionStore,
} from "./store/session-store.ts";
import { TrajectoryView } from "./TrajectoryView.tsx";
import type { BridgeMessage, ModelProfile, PermissionRequest, SessionSummary, WorklistItem } from "./types.ts";

type Theme = "light" | "dark";
type View = "chat" | "trajectory" | "worklist" | "graph";

const STATUS_LABELS: Record<string, string> = {
	idle: "空闲",
	running: "运行中",
	error: "错误",
	paused: "已暂停",
	cancelled: "已停止",
	closed: "已关闭",
};

const ROLE_LABELS: Record<string, string> = {
	main: "Main Agent",
	solver: "Solver",
	agent: "临时 Agent",
	local: "会话",
};

function statusLabel(status: string): string {
	return STATUS_LABELS[status] ?? status;
}

function formatTime(timestamp: number): string {
	if (!timestamp) return "";
	return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp * 1000));
}

function formatRelative(timestamp: number): string {
	if (!timestamp) return "";
	const seconds = Math.max(0, Date.now() / 1000 - timestamp);
	if (seconds < 60) return "刚刚";
	if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
	return `${Math.floor(seconds / 86400)} 天前`;
}

function messageText(message: BridgeMessage): string {
	return typeof message.content === "string" ? message.content : String(message.content ?? "");
}

function markdownHtml(content: string): string {
	const rendered = marked.parse(content, { breaks: true, gfm: true });
	return DOMPurify.sanitize(typeof rendered === "string" ? rendered : "");
}

function useTheme(): [Theme, () => void] {
	const [theme, setTheme] = useState<Theme>(() => {
		if (typeof window === "undefined") return "light";
		const saved = window.localStorage.getItem("app-shell-theme");
		if (saved === "dark" || saved === "light") return saved;
		return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
	});
	useEffect(() => {
		document.documentElement.dataset.theme = theme;
		window.localStorage.setItem("app-shell-theme", theme);
	}, [theme]);
	return [theme, () => setTheme((current) => (current === "dark" ? "light" : "dark"))];
}

function App(): JSX.Element {
	const client = useMemo(() => createDefaultClient(), []);
	const [theme, toggleTheme] = useTheme();
	const [view, setView] = useState<View>("chat");
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [models, setModels] = useState<ModelProfile[]>([]);
	const [bootstrapDone, setBootstrapDone] = useState(false);
	const [planningEngine, setPlanningEngine] = useState<PlanningEngine>();
	const [planningSaving, setPlanningSaving] = useState(false);
	const [planningError, setPlanningError] = useState("");
	const connection = useSessionStore((state) => state.connection);
	const activeSessionId = useSessionStore((state) => state.activeSessionId);
	const sessions = useSessionStore((state) => state.sessionsById);
	const sessionOrder = useSessionStore((state) => state.sessionOrder);
	const worklist = useSessionStore((state) => state.worklist);
	const lastError = useSessionStore((state) => state.lastError);

	useEffect(() => {
		sessionStore.attach(client);
		void client
			.getPlanningOptions()
			.then((options) => setPlanningEngine(options.engine))
			.catch(() => setPlanningError("当前后端不支持 PLAN 切换"));
		void sessionStore.bootstrap().finally(() => setBootstrapDone(true));
		void client
			.listModels()
			.then(setModels)
			.catch(() => setModels([]));
		return () => sessionStore.detach();
	}, [client]);

	const activeSession = activeSessionId ? (sessions.get(activeSessionId) ?? null) : null;
	const conversations = sessionOrder
		.map((id) => sessions.get(id))
		.filter((session): session is SessionSummary => Boolean(session && session.role !== "solver"));
	const solvers = sessionOrder
		.map((id) => sessions.get(id))
		.filter((session): session is SessionSummary => Boolean(session && session.role === "solver"));

	function selectSession(sessionId: string): void {
		setView("chat");
		setSidebarOpen(false);
		void sessionStore.openSession(sessionId);
	}
	async function selectPlanningEngine(engine: PlanningEngine): Promise<void> {
		setPlanningSaving(true);
		try {
			const options = await client.setPlanningEngine(engine);
			setPlanningEngine(options.engine);
			setPlanningError("");
		} catch (error) {
			setPlanningError(error instanceof Error ? error.message : "保存 PLAN 失败");
		} finally {
			setPlanningSaving(false);
		}
	}

	return (
		<div className="app-window">
			<header className="titlebar">
				<div className="traffic-lights" aria-hidden="true">
					<span />
					<span />
					<span />
				</div>
				<button
					className="mobile-sidebar-button icon-button"
					type="button"
					aria-label="打开侧栏"
					onClick={() => setSidebarOpen(true)}
				>
					<PanelLeft size={17} strokeWidth={1.8} />
				</button>
				<div className="titlebar-title">SecHeur Agent</div>
				<div className="titlebar-actions">
					<label className="planning-selector" title={planningError || "仅用于新会话，已有会话保留原模式"}>
						新会话 PLAN
						<select
							aria-label="新会话 PLAN"
							value={planningEngine ?? ""}
							disabled={!planningEngine || planningSaving}
							onChange={(event) => void selectPlanningEngine(event.target.value as PlanningEngine)}
						>
							{!planningEngine ? <option value="">暂不可用</option> : null}
							<option value="progressive">Progressive</option>
							<option value="cairn">Cairn</option>
							<option value="hypothesis">Hypothesis · 假设图</option>
							<option value="artex">Artex · 探索图</option>
						</select>
					</label>
					{planningError ? <span role="alert">{planningError}</span> : null}
					<span className={`connection-dot ${connection}`} title={`连接状态：${connectionLabel(connection)}`} />
					<button
						className="icon-button"
						type="button"
						aria-label="切换深浅色"
						title="切换深浅色"
						onClick={toggleTheme}
					>
						{theme === "dark" ? <Sun size={16} strokeWidth={1.8} /> : <Moon size={16} strokeWidth={1.8} />}
					</button>
					<button
						className="icon-button"
						type="button"
						aria-label="打开设置"
						title="设置"
						onClick={() => setSettingsOpen(true)}
					>
						<Settings size={16} strokeWidth={1.8} />
					</button>
				</div>
			</header>
			<div className="shell">
				{sidebarOpen ? (
					<button
						className="sidebar-scrim"
						type="button"
						aria-label="关闭侧栏"
						onClick={() => setSidebarOpen(false)}
					/>
				) : null}
				<Sidebar
					conversations={conversations}
					solvers={solvers}
					activeSessionId={activeSessionId}
					connection={connection}
					worklist={worklist}
					view={view}
					open={sidebarOpen}
					onSelectSession={selectSession}
					onNewSession={() => {
						if (!planningSaving) void sessionStore.createSession(planningEngine);
					}}
					onSelectView={(nextView) => {
						setView(nextView);
						setSidebarOpen(false);
					}}
					onSettings={() => setSettingsOpen(true)}
					onWorklistAction={(action) => void sessionStore.changeWorklist(action)}
				/>
				<main className="main-content">
					{view === "worklist" ? (
						<WorklistView worklist={worklist} onSelectSession={selectSession} />
					) : (
						<>
							<ConversationHeader
								session={activeSession}
								view={view}
								onSelectView={setView}
								onRefresh={() => {
									void sessionStore.refreshSessionSummaries(true);
									if (activeSessionId) void sessionStore.refreshMessages(activeSessionId, true);
								}}
							/>
							{activeSession ? (
								view === "graph" && activeSession.planningEngine === "artex" ? (
									<ExplorationGraphView key={activeSession.id} client={client} sessionId={activeSession.id} />
								) : view === "trajectory" ? (
									<TrajectoryView client={client} session={activeSession} />
								) : (
									<>
										<Transcript session={activeSession} />
										<Composer session={activeSession} models={models} />
									</>
								)
							) : (
								<EmptyState
									ready={bootstrapDone && !planningSaving}
									onCreate={() => void sessionStore.createSession(planningEngine)}
								/>
							)}
						</>
					)}
				</main>
			</div>
			{lastError ? <ErrorToast message={lastError} /> : null}
			{settingsOpen ? (
				<SettingsDialog
					theme={theme}
					onToggleTheme={toggleTheme}
					onClose={() => setSettingsOpen(false)}
					connection={connection}
				/>
			) : null}
			<PermissionCenter />
		</div>
	);
}

function connectionLabel(connection: string): string {
	return connection === "connected"
		? "已连接"
		: connection === "reconnecting"
			? "重连中"
			: connection === "connecting"
				? "连接中"
				: "离线";
}

interface SidebarProps {
	conversations: SessionSummary[];
	solvers: SessionSummary[];
	activeSessionId: string | null;
	connection: string;
	worklist: ReturnType<typeof sessionStore.getWorklistSnapshot>;
	view: View;
	open: boolean;
	onSelectSession: (id: string) => void;
	onNewSession: () => void;
	onSelectView: (view: View) => void;
	onSettings: () => void;
	onWorklistAction: (action: "start" | "stop" | "sync") => void;
}

function Sidebar(props: SidebarProps): JSX.Element {
	const visibleConversations = props.conversations.slice(0, 8);
	// Solver 摘要很轻量，滚动区域应展示全部会话，不能静默隐藏较早的 Solver。
	const visibleSolvers = props.solvers;
	return (
		<aside className={`sidebar ${props.open ? "is-open" : ""}`} aria-label="导航">
			<div className="brand-block">
				<img src={logoUrl} alt="" className="brand-logo" />
				<div>
					<div className="brand-title">SecHeur Agent</div>
					<div className="brand-subtitle">CTF reasoning workspace</div>
				</div>
			</div>
			<nav className="primary-nav" aria-label="主导航">
				<button
					className={`nav-item ${props.view === "chat" ? "active" : ""}`}
					type="button"
					onClick={() => props.onSelectView("chat")}
				>
					<MessageSquare size={16} strokeWidth={1.8} />
					<span>对话</span>
				</button>
				<button
					className={`nav-item ${props.view === "worklist" ? "active" : ""}`}
					type="button"
					onClick={() => props.onSelectView("worklist")}
				>
					<LayoutList size={16} strokeWidth={1.8} />
					<span>工作列表</span>
					{props.worklist?.items.length ? <span className="nav-count">{props.worklist.items.length}</span> : null}
				</button>
				<button
					className={`nav-item ${props.view === "trajectory" ? "active" : ""}`}
					type="button"
					disabled={!props.activeSessionId}
					onClick={() => props.onSelectView("trajectory")}
				>
					<Route size={16} strokeWidth={1.8} />
					<span>会话轨迹</span>
				</button>
				<a
					className="nav-item nav-link"
					href="/index.html"
					target="_blank"
					rel="noreferrer"
					title="打开 legacy Conversation Trace UI"
				>
					<Puzzle size={16} strokeWidth={1.8} />
					<span>插件版界面</span>
					<ExternalLink size={12} strokeWidth={1.8} aria-hidden="true" />
				</a>
			</nav>
			<section className="sidebar-section">
				<div className="section-label">
					<span>最近对话</span>
					<button
						className="tiny-button"
						type="button"
						aria-label="新建对话"
						title="新建对话"
						onClick={props.onNewSession}
					>
						<Plus size={15} strokeWidth={1.8} />
					</button>
				</div>
				<div className="session-list">
					{visibleConversations.length === 0 ? (
						<div className="sidebar-empty">暂无会话</div>
					) : (
						visibleConversations.map((session) => (
							<SessionRow
								key={session.id}
								session={session}
								active={session.id === props.activeSessionId}
								onClick={() => props.onSelectSession(session.id)}
							/>
						))
					)}
				</div>
			</section>
			{visibleSolvers.length > 0 ? (
				<section className="sidebar-section solver-section">
					<div className="section-label">
						<span>后台 Solver</span>
						<span className="section-count">{props.solvers.length}</span>
					</div>
					<div className="session-list">
						{visibleSolvers.map((session) => (
							<SessionRow
								compact
								key={session.id}
								session={session}
								active={session.id === props.activeSessionId}
								onClick={() => props.onSelectSession(session.id)}
							/>
						))}
					</div>
				</section>
			) : null}
			<section className="sidebar-section worklist-section">
				<div className="section-label">
					<span>CTF 工作列表</span>
					<span className={`status-pill ${props.worklist?.running ? "ok" : "muted"}`}>
						{props.worklist?.running ? "运行中" : "待机"}
					</span>
				</div>
				<div className="worklist-mini">
					{props.worklist?.items.slice(0, 4).map((item) => <WorklistMiniRow key={item.id} item={item} />) ?? (
						<div className="sidebar-empty">等待同步</div>
					)}
				</div>
				<div className="worklist-actions">
					<button className="text-button" type="button" onClick={() => props.onWorklistAction("sync")}>
						<RefreshCw size={13} strokeWidth={1.8} />
						同步
					</button>
					<button
						className="text-button"
						type="button"
						onClick={() => props.onWorklistAction(props.worklist?.running ? "stop" : "start")}
					>
						<Activity size={13} strokeWidth={1.8} />
						{props.worklist?.running ? "停止" : "启动"}
					</button>
				</div>
			</section>
			<div className="sidebar-footer">
				<div className="connection-status">
					<span className={`status-dot ${props.connection === "connected" ? "ready" : ""}`} />
					Bridge {connectionLabel(props.connection)}
				</div>
				<button className="settings-link" type="button" onClick={props.onSettings}>
					<Settings size={16} strokeWidth={1.8} />
					<span>设置</span>
					<span className="version">v0.1.0</span>
				</button>
			</div>
		</aside>
	);
}

interface SessionRowProps {
	session: SessionSummary;
	active: boolean;
	compact?: boolean;
	onClick: () => void;
}

function SessionRow({ session, active, compact, onClick }: SessionRowProps): JSX.Element {
	return (
		<button
			className={`session-row ${active ? "active" : ""} ${compact ? "compact" : ""}`}
			type="button"
			onClick={onClick}
			title={session.title}
		>
			<span className={`session-mark ${session.status}`}>
				<span />
			</span>
			<span className="session-copy">
				<strong>{session.title || "未命名会话"}</strong>
				<small>
					{compact
						? `${session.category || "Solver"} · ${statusLabel(session.status)}`
						: formatRelative(session.updatedAt)}
				</small>
			</span>
			{session.status === "running" ? <Activity className="session-activity" size={13} strokeWidth={1.8} /> : null}
		</button>
	);
}

function WorklistMiniRow({ item }: { item: WorklistItem }): JSX.Element {
	return (
		<div className="worklist-mini-row">
			<span className={`task-dot ${item.status}`} />
			<span title={item.name}>{item.name}</span>
			<small>{item.attempts}</small>
		</div>
	);
}

function ConversationHeader({
	session,
	view,
	onSelectView,
	onRefresh,
}: {
	session: SessionSummary | null;
	view: View;
	onSelectView: (view: View) => void;
	onRefresh: () => void;
}): JSX.Element {
	return (
		<header className="content-header">
			<div className="content-heading">
				<div className="eyebrow">{session ? (ROLE_LABELS[session.role] ?? "会话") : "WORKSPACE"}</div>
				<h1>{session?.title ?? "欢迎"}</h1>
				<p>
					{session
						? `${session.cwd || "当前工作区"} · 当前模式：${session.executionMode === "direct" ? "Direct" : typeof session.planningEngine === "string" ? session.planningEngine : "未知"}`
						: "连接后即可开始新的 CTF 推理任务"}
				</p>
			</div>
			<div className="header-actions">
				{session ? (
					<div className="view-switcher" role="tablist" aria-label="会话视图">
						{session.planningEngine === "artex" ? (
							<button
								type="button"
								role="tab"
								className={`view-tab ${view === "graph" ? "active" : ""}`}
								aria-selected={view === "graph"}
								onClick={() => onSelectView("graph")}
							>
								探索图
							</button>
						) : null}
						<button
							className={`view-tab ${view === "chat" ? "active" : ""}`}
							type="button"
							role="tab"
							aria-selected={view === "chat"}
							onClick={() => onSelectView("chat")}
						>
							<MessageSquare size={13} strokeWidth={1.8} />
							对话
						</button>
						<button
							className={`view-tab ${view === "trajectory" ? "active" : ""}`}
							type="button"
							role="tab"
							aria-selected={view === "trajectory"}
							onClick={() => onSelectView("trajectory")}
						>
							<Route size={13} strokeWidth={1.8} />
							轨迹
						</button>
					</div>
				) : null}
				{session ? (
					<span
						className={`status-pill ${session.status === "running" ? "hot" : session.status === "error" ? "danger" : "ok"}`}
					>
						<span className="pill-dot" />
						{statusLabel(session.status)}
					</span>
				) : null}
				<button
					className="icon-button bordered"
					type="button"
					aria-label="刷新会话"
					title="刷新会话"
					onClick={onRefresh}
				>
					<RefreshCw size={15} strokeWidth={1.8} />
				</button>
			</div>
		</header>
	);
}

function EmptyState({ ready, onCreate }: { ready: boolean; onCreate: () => void }): JSX.Element {
	return (
		<section className="empty-state">
			<div className="empty-icon">
				<ShieldCheck size={30} strokeWidth={1.5} />
			</div>
			<h2>{ready ? "欢迎" : "正在连接 Bridge"}</h2>
			<p>{ready ? "今天想构建什么？" : "正在加载会话"}</p>
			{ready ? (
				<button className="primary-button" type="button" onClick={onCreate}>
					<Plus size={16} strokeWidth={1.8} />
					新建对话
				</button>
			) : (
				<span className="loading-line">
					<span />
					{connectionLabel(sessionStore.connection)}
				</span>
			)}
		</section>
	);
}

function Transcript({ session }: { session: SessionSummary }): JSX.Element {
	const messages = useSessionMessages(session.id);
	const partial = useSessionPartial(session.id);
	const operation = useSessionOperation(session.id);
	const scrollRef = useRef<HTMLDivElement>(null);
	const [atBottom, setAtBottom] = useState(true);
	const rows = useMemo(() => buildConversationRows(partial ? [...messages, partial] : messages), [messages, partial]);
	const rowCount = rows.length;
	// 同一条 partial 消息增长时行数不变；用轻量内容版本触发底部跟随，而不是每次重建整行数据。
	const streamingVersion = partial
		? `${partial.id}:${partial.content.length}:${partial.thinking?.length ?? 0}:${partial.content.slice(-12)}`
		: "";
	const virtualizer = useVirtualizer({
		count: rowCount,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => 96,
		overscan: 8,
	});
	// 虚拟列表只挂载可见行，避免长会话拖慢页面。
	useEffect(() => {
		if (rowCount === 0 || !atBottom || !scrollRef.current) return;
		// 依赖 streamingVersion，让同一条流式消息增长时也能跟随到底部。
		void streamingVersion;
		scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
	}, [rowCount, atBottom, streamingVersion]);

	function handleScroll(): void {
		const element = scrollRef.current;
		if (!element) return;
		setAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
	}

	return (
		<section className="transcript-region" aria-live="polite">
			<div className="transcript-scroll" ref={scrollRef} onScroll={handleScroll}>
				{rows.length === 0 ? (
					<div className="transcript-empty">
						<MessageSquare size={20} strokeWidth={1.6} />
						<span>发送第一条消息开始任务</span>
					</div>
				) : (
					<div className="message-stack virtual-stack" style={{ height: `${virtualizer.getTotalSize()}px` }}>
						{virtualizer.getVirtualItems().map((item) => {
							const row = rows[item.index];
							return (
								<div
									className="virtual-row"
									key={row.key}
									data-index={item.index}
									ref={virtualizer.measureElement}
									style={{ transform: `translateY(${item.start}px)` }}
								>
									{row.kind === "tool" ? (
										<ConversationToolRow tool={row.tool} />
									) : (
										<MessageBubble message={row.message} sessionId={session.id} />
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>
			{!atBottom && rows.length > 0 ? (
				<button
					className="jump-button"
					type="button"
					onClick={() => {
						if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
						setAtBottom(true);
					}}
				>
					<ChevronDown size={14} strokeWidth={1.8} />
					新内容
				</button>
			) : null}
			{operation.status === "running" ? (
				<div className="operation-line">
					<span className="pulse" />
					{operation.label}
				</div>
			) : null}
		</section>
	);
}

function ConversationToolRow({ tool }: { tool: ConversationToolRecord }): JSX.Element {
	const [expanded, setExpanded] = useState(false);
	const statusLabel =
		tool.status === "running"
			? "正在运行"
			: tool.status === "error"
				? "运行失败"
				: tool.status === "stopped"
					? "已停止"
					: "已完成";
	return (
		<details
			className={`conversation-tool-row ${tool.status}`}
			open={expanded}
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary aria-label={`${tool.toolName}：${conversationToolSummary(tool)}，${statusLabel}`}>
				<span className="conversation-tool-icon">
					{tool.status === "error" ? (
						<AlertCircle size={14} strokeWidth={1.8} />
					) : (
						<TerminalSquare size={14} strokeWidth={1.8} />
					)}
				</span>
				<span className="conversation-tool-copy">
					<strong>{tool.toolName}</strong>
					<span>{conversationToolSummary(tool)}</span>
				</span>
				<span className="conversation-tool-status">
					{tool.status === "running" ? <span className="pulse" /> : null}
					{statusLabel}
				</span>
				<ChevronRight className="tool-chevron" size={14} strokeWidth={1.8} />
			</summary>
			<div className="conversation-tool-detail">
				{tool.requestText ? <ConversationToolSection title="Input" value={tool.requestText} /> : null}
				{tool.resultText ? (
					<ConversationToolSection title={tool.isError ? "Error" : "Output"} value={tool.resultText} />
				) : null}
				{!tool.requestText && !tool.resultText ? (
					<span className="conversation-tool-empty">等待工具输出</span>
				) : null}
			</div>
		</details>
	);
}

function ConversationToolSection({ title, value }: { title: string; value: string }): JSX.Element {
	return (
		<section>
			<h3>{title}</h3>
			<pre>{value}</pre>
		</section>
	);
}

function MessageBubble({ message, sessionId }: { message: BridgeMessage; sessionId: string }): JSX.Element {
	const role = message.role;
	const text = messageText(message);
	const isUser = role === "user";
	const isError = role === "error";
	const isPermission = role === "permission";
	const isPartial = message.partial === true;
	if (isPermission) return <PermissionBubble message={message} sessionId={sessionId} />;
	const assistant = !isUser && !isError ? splitAssistantContent(text, message.thinking) : null;
	const visibleText = assistant?.response ?? text;
	return (
		<article className={`message-row ${isUser ? "user" : "assistant"} ${isError ? "error" : ""}`}>
			<div className="message-avatar">
				{isUser ? (
					<Command size={14} strokeWidth={1.8} />
				) : isError ? (
					<AlertCircle size={14} strokeWidth={1.8} />
				) : (
					<Bot size={15} strokeWidth={1.8} />
				)}
			</div>
			<div className="message-body">
				<div className="message-meta">
					<span>{isUser ? "你" : isError ? "Bridge" : "Agent"}</span>
					<time>{formatTime(message.ts)}</time>
					{isPartial ? <span className="streaming-label">流式输出</span> : null}
				</div>
				{assistant?.thinking ? (
					<details className="thinking-block">
						<summary>
							<Activity size={13} strokeWidth={1.8} />
							<span>{assistant.summary}</span>
							<ChevronRight className="tool-chevron" size={13} strokeWidth={1.8} />
						</summary>
						<pre>{assistant.thinking}</pre>
					</details>
				) : null}
				{isPartial ? (
					<div className="message-text plain">
						{visibleText}
						<span className="caret" />
					</div>
				) : visibleText ? (
					<RenderedMessage content={visibleText} user={isUser} />
				) : null}
			</div>
		</article>
	);
}

function RenderedMessage({ content, user }: { content: string; user: boolean }): JSX.Element {
	const element = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!element.current) return;
		// Markdown 写入 DOM 前会清理，用户文本则先转义。
		element.current.innerHTML = user ? escapeHtml(content) : markdownHtml(content);
	}, [content, user]);
	return <div ref={element} className="message-text" />;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#039;")
		.replaceAll("\n", "<br />");
}

function PermissionBubble({ message, sessionId }: { message: BridgeMessage; sessionId: string }): JSX.Element {
	const requestId = String(message.requestId || message.request_id || "");
	const request: PermissionRequest = {
		sessionId: sessionId ?? "",
		requestId,
		toolName: String(message.toolName || message.tool_name || "工具"),
		message: messageText(message),
		args: message.detail ?? null,
		status: message.status === "resolved" ? "resolved" : "pending",
		createdAt: message.ts,
		choices: Array.isArray(message.choices)
			? message.choices.filter((value): value is string => typeof value === "string")
			: [],
	};
	return <PermissionPrompt request={request} />;
}

function PermissionPrompt({ request }: { request: PermissionRequest }): JSX.Element {
	return (
		<article className={`permission-card ${request.status === "resolved" ? "resolved" : ""}`}>
			<div className="permission-heading">
				<ShieldCheck size={16} strokeWidth={1.8} />
				<div>
					<strong>{request.toolName}</strong>
					<span>{request.status === "resolved" ? "已处理" : "需要确认"}</span>
				</div>
			</div>
			<p>{request.message}</p>
			{request.status === "pending" && request.sessionId ? (
				<div className="permission-actions">
					<button
						className="secondary-button"
						type="button"
						onClick={() => void sessionStore.resolvePermission(request, "deny")}
					>
						拒绝
					</button>
					<button
						className="primary-button small"
						type="button"
						onClick={() => void sessionStore.resolvePermission(request, "allow_once")}
					>
						允许一次
					</button>
					<button
						className="ghost-button"
						type="button"
						onClick={() => void sessionStore.resolvePermission(request, "allow_session")}
					>
						本会话允许
					</button>
				</div>
			) : null}
		</article>
	);
}

function PermissionCenter(): JSX.Element | null {
	const permissions = useSessionPermissions();
	const pending = [...permissions.values()].filter((request) => request.status === "pending");
	if (pending.length === 0) return null;
	return (
		<aside className="permission-center" aria-label="待确认权限" role="alertdialog" aria-live="assertive">
			<div className="permission-center-heading">
				<ShieldCheck size={16} strokeWidth={1.8} />
				<strong>{pending.length > 1 ? `${pending.length} 个操作等待确认` : "操作需要确认"}</strong>
			</div>
			<div className="permission-center-list">
				{pending.map((request) => (
					<PermissionPrompt key={`${request.sessionId}:${request.requestId}`} request={request} />
				))}
			</div>
		</aside>
	);
}

function Composer({ session, models }: { session: SessionSummary; models: ModelProfile[] }): JSX.Element {
	const [text, setText] = useState("");
	const [permissionMode, setPermissionMode] = useState(session.permissionMode || "default");
	const [modelKey, setModelKey] = useState("");
	const operation = useSessionOperation(session.id);
	const canSend = text.trim().length > 0 && operation.status !== "running";

	useEffect(() => setPermissionMode(session.permissionMode || "default"), [session.permissionMode]);
	useEffect(() => {
		const selected = models.find((model) => model.selected) ?? models[0];
		if (selected) setModelKey(`${selected.provider}:${selected.id}`);
	}, [models]);

	async function submit(event?: FormEvent): Promise<void> {
		event?.preventDefault();
		if (!canSend) return;
		const selected = models.find((model) => `${model.provider}:${model.id}` === modelKey);
		const options: PromptOptions = selected
			? {
					modelIndex:
						typeof selected.llmNo === "number"
							? selected.llmNo
							: models.findIndex((model) => model.provider === selected.provider && model.id === selected.id),
				}
			: {};
		await sessionStore.setPermissionMode(permissionMode);
		await sessionStore.sendPrompt(text, options);
		setText("");
	}

	function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			void submit();
		}
	}

	return (
		<form className="composer" onSubmit={(event) => void submit(event)}>
			<div className="composer-topline">
				<span>
					<span className="composer-status-dot" />
					{operation.status === "running" ? operation.label : "准备就绪"}
				</span>
				<span className="composer-hint">Enter 发送 · Shift + Enter 换行</span>
			</div>
			<textarea
				value={text}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={handleKeyDown}
				rows={2}
				placeholder="输入消息，或描述要分析的挑战…"
				aria-label="消息输入框"
			/>
			<div className="composer-toolbar">
				<div className="composer-controls">
					<label className="select-control">
						<ShieldCheck size={14} strokeWidth={1.8} />
						<select
							value={permissionMode}
							onChange={(event) => {
								setPermissionMode(event.target.value);
								void sessionStore.setPermissionMode(event.target.value);
							}}
							aria-label="权限模式"
						>
							<option value="default">默认权限</option>
							<option value="acceptEdits">自动接受编辑</option>
							<option value="dontAsk">自动审查</option>
							<option value="plan">计划模式</option>
							<option value="bypassPermissions">完全访问权限</option>
						</select>
					</label>
					<label className="select-control">
						<Bot size={14} strokeWidth={1.8} />
						<select value={modelKey} onChange={(event) => setModelKey(event.target.value)} aria-label="模型">
							<option value="">默认模型</option>
							{models.map((model) => (
								<option key={`${model.provider}:${model.id}`} value={`${model.provider}:${model.id}`}>
									{model.name || model.id}
								</option>
							))}
						</select>
					</label>
				</div>
				<div className="composer-actions">
					{operation.status === "running" ? (
						<button
							className="stop-button"
							type="button"
							title="停止当前任务"
							aria-label="停止当前任务"
							onClick={() => void sessionStore.cancelActive()}
						>
							<CircleStop size={17} strokeWidth={1.8} />
						</button>
					) : null}
					<button className="send-button" type="submit" disabled={!canSend} aria-label="发送消息" title="发送消息">
						<Send size={17} strokeWidth={1.8} />
					</button>
				</div>
			</div>
		</form>
	);
}

function WorklistView({
	worklist,
	onSelectSession,
}: {
	worklist: ReturnType<typeof sessionStore.getWorklistSnapshot>;
	onSelectSession: (id: string) => void;
}): JSX.Element {
	return (
		<div className="view-page">
			<header className="content-header">
				<div className="content-heading">
					<div className="eyebrow">PARALLEL RUNS</div>
					<h1>工作列表</h1>
					<p>按需打开 Solver transcript，后台只保留摘要。</p>
				</div>
				<div className="header-actions">
					<span className={`status-pill ${worklist?.running ? "ok" : "muted"}`}>
						<span className="pill-dot" />
						{worklist?.running ? "运行中" : "待机"}
					</span>
				</div>
			</header>
			<section className="worklist-panel">
				<div className="panel-toolbar">
					<div>
						<strong>{worklist?.items.length ?? 0} 个任务</strong>
						<span> · 最近更新 {worklist ? formatRelative(worklist.updatedAt / 1000) : "--"}</span>
					</div>
					<span className="panel-meta">有界并发视图</span>
				</div>
				<div className="worklist-table">
					{worklist?.items.length ? (
						worklist.items.map((item) => (
							<WorklistRow key={item.id} item={item} onSelectSession={onSelectSession} />
						))
					) : (
						<div className="panel-empty">
							<LayoutList size={22} strokeWidth={1.5} />
							<span>暂无工作项</span>
						</div>
					)}
				</div>
			</section>
		</div>
	);
}

function WorklistRow({
	item,
	onSelectSession,
}: {
	item: WorklistItem;
	onSelectSession: (id: string) => void;
}): JSX.Element {
	return (
		<div className="worklist-row">
			<div className="task-state">
				<span className={`task-dot ${item.status}`} />
				<div>
					<strong>{item.name}</strong>
					<small>
						{item.category || "未分类"} · 优先级 {item.priority}
					</small>
				</div>
			</div>
			<span
				className={`status-pill ${item.status === "solved" ? "ok" : item.status === "running" ? "hot" : item.status === "blocked" ? "danger" : "muted"}`}
			>
				{item.status}
			</span>
			<span className="attempt-count">{item.attempts} 次尝试</span>
			{item.sessionId ? (
				<button className="ghost-button small" type="button" onClick={() => onSelectSession(item.sessionId ?? "")}>
					<MessageSquare size={14} strokeWidth={1.8} />
					打开
				</button>
			) : (
				<span className="not-attached">未连接</span>
			)}
		</div>
	);
}

function ErrorToast({ message }: { message: string }): JSX.Element {
	return (
		<div className="error-toast" role="alert">
			<AlertCircle size={16} strokeWidth={1.8} />
			<span>{message}</span>
			<button
				type="button"
				className="icon-button"
				aria-label="关闭错误提示"
				title="关闭"
				onClick={() => sessionStore.clearError()}
			>
				<X size={15} strokeWidth={1.8} />
			</button>
		</div>
	);
}

function SettingsDialog({
	theme,
	onToggleTheme,
	onClose,
	connection,
}: {
	theme: Theme;
	onToggleTheme: () => void;
	onClose: () => void;
	connection: string;
}): JSX.Element {
	return (
		<div className="modal-backdrop">
			<button className="modal-dismiss" type="button" aria-label="关闭设置" onClick={onClose} />
			<section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
				<header>
					<div>
						<div className="eyebrow">PREFERENCES</div>
						<h2 id="settings-title">设置</h2>
					</div>
					<button className="icon-button" type="button" aria-label="关闭设置" title="关闭" onClick={onClose}>
						<X size={17} strokeWidth={1.8} />
					</button>
				</header>
				<div className="settings-list">
					<div className="setting-row">
						<div className="setting-icon">
							<Sun size={16} strokeWidth={1.8} />
						</div>
						<div>
							<strong>外观</strong>
							<span>切换浅色和深色主题</span>
						</div>
						<button className="secondary-button" type="button" onClick={onToggleTheme}>
							{theme === "dark" ? "深色" : "浅色"}
						</button>
					</div>
					<div className="setting-row">
						<div className="setting-icon">
							<Wifi size={16} strokeWidth={1.8} />
						</div>
						<div>
							<strong>Bridge 连接</strong>
							<span>HTTP 命令与 SSE 事件通道</span>
						</div>
						<span className={`status-pill ${connection === "connected" ? "ok" : "danger"}`}>
							{connectionLabel(connection)}
						</span>
					</div>
					<div className="setting-row">
						<div className="setting-icon">
							<Users size={16} strokeWidth={1.8} />
						</div>
						<div>
							<strong>会话加载策略</strong>
							<span>列表只加载摘要，打开会话后按页读取消息</span>
						</div>
						<span className="setting-value">已启用</span>
					</div>
					<div className="setting-row">
						<div className="setting-icon">
							<Clock3 size={16} strokeWidth={1.8} />
						</div>
						<div>
							<strong>事件刷新</strong>
							<span>流式事件 50 ms 合并，避免完整页面重绘</span>
						</div>
						<span className="setting-value">50 ms</span>
					</div>
				</div>
				<footer>
					<span className="settings-footnote">
						<ShieldCheck size={14} strokeWidth={1.8} />
						API 配置沿用服务器端设置
					</span>
					<button className="primary-button" type="button" onClick={onClose}>
						完成
					</button>
				</footer>
			</section>
		</div>
	);
}

export default App;
