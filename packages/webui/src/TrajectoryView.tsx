import { useVirtualizer } from "@tanstack/react-virtual";
import {
	Activity,
	AlertCircle,
	Bot,
	ChevronRight,
	Clock3,
	MessageSquare,
	RefreshCw,
	Search,
	TerminalSquare,
} from "lucide-react";
import { type CSSProperties, type JSX, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BridgeClient } from "./bridge/client.ts";
import {
	buildTrajectory,
	matchesTrajectoryQuery,
	mergeRuntimeLogPayload,
	recordDuration,
	TRAJECTORY_LANE,
	type TrajectoryKind,
	type TrajectoryModel,
	type TrajectoryRecord,
	trajectoryRange,
} from "./trajectory.ts";
import type { RuntimeLogPayload, SessionSummary } from "./types.ts";

const EMPTY_TRAJECTORY: TrajectoryModel = { records: [], turns: 0, calls: 0 };

const KIND_LABELS: Record<TrajectoryKind, string> = {
	system: "SYSTEM",
	context: "CONTEXT",
	user: "USER",
	assistant: "MODEL",
	tool: "TOOL",
};

function formatDuration(milliseconds: number): string {
	const duration = Math.max(0, milliseconds);
	if (duration < 1000) return `${Math.round(duration)} ms`;
	const seconds = duration / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)} s`;
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds - minutes * 60;
	if (minutes < 60) return `${minutes} m ${remainder.toFixed(0)} s`;
	return `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
}

function formatRecordedTime(timestamp: number): string {
	return new Intl.DateTimeFormat("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(new Date(timestamp));
}

function kindIcon(record: TrajectoryRecord): JSX.Element {
	if (record.isError) return <AlertCircle size={14} strokeWidth={1.8} />;
	if (record.kind === "tool") return <TerminalSquare size={14} strokeWidth={1.8} />;
	if (record.kind === "assistant") return <Bot size={14} strokeWidth={1.8} />;
	if (record.kind === "user") return <MessageSquare size={14} strokeWidth={1.8} />;
	return <Activity size={14} strokeWidth={1.8} />;
}

function timelineColor(record: TrajectoryRecord): string {
	if (record.isError) return "var(--text-danger)";
	if (record.kind === "assistant") return "var(--trace-model)";
	if (record.kind === "tool") return "var(--text-warning)";
	if (record.kind === "context") return "var(--text-success)";
	if (record.kind === "user") return "var(--primary)";
	return "var(--text-tertiary)";
}

export function TrajectoryView({ client, session }: { client: BridgeClient; session: SessionSummary }): JSX.Element {
	const [trajectory, setTrajectory] = useState<TrajectoryModel>(EMPTY_TRAJECTORY);
	const [selectedId, setSelectedId] = useState("");
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const requestSerial = useRef(0);
	const refreshGeneration = useRef(0);
	const inFlight = useRef(false);
	const queuedGeneration = useRef<number | null>(null);
	const payloadRef = useRef<RuntimeLogPayload | null>(null);
	const refreshRef = useRef<((showLoading?: boolean) => Promise<void>) | null>(null);
	const ledgerRef = useRef<HTMLDivElement>(null);

	const refresh = useCallback(
		async (showLoading = false): Promise<void> => {
			const generation = refreshGeneration.current;
			if (inFlight.current) {
				queuedGeneration.current = generation;
				if (showLoading) setLoading(true);
				return;
			}
			inFlight.current = true;
			const serial = ++requestSerial.current;
			if (showLoading) setLoading(true);
			try {
				const previous = payloadRef.current;
				const runtimeLog = await client.getRuntimeLog(
					session.id,
					previous
						? {
								afterEventId: previous.eventCursor ?? 0,
								afterMessageId: previous.messageCursor ?? 0,
								...(previous.logEpoch ? { logEpoch: previous.logEpoch } : {}),
								includeMessages: true,
							}
						: undefined,
				);
				if (serial !== requestSerial.current) return;
				const mergedPayload = mergeRuntimeLogPayload(previous, runtimeLog);
				payloadRef.current = mergedPayload;
				const next = buildTrajectory(mergedPayload);
				setTrajectory(next);
				setSelectedId((current) =>
					next.records.some((record) => record.id === current) ? current : (next.records.at(-1)?.id ?? ""),
				);
				setError("");
			} catch (refreshError) {
				if (serial !== requestSerial.current) return;
				setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
			} finally {
				inFlight.current = false;
				if (serial === requestSerial.current) setLoading(false);
				if (queuedGeneration.current === refreshGeneration.current) {
					queuedGeneration.current = null;
					void refreshRef.current?.();
				} else {
					queuedGeneration.current = null;
				}
			}
		},
		[client, session.id],
	);
	refreshRef.current = refresh;

	useEffect(() => {
		refreshGeneration.current += 1;
		setTrajectory(EMPTY_TRAJECTORY);
		setSelectedId("");
		setQuery("");
		payloadRef.current = null;
		queuedGeneration.current = inFlight.current ? refreshGeneration.current : null;
		void refresh(true);
		const timer = session.status === "running" ? window.setInterval(() => void refresh(), 1200) : undefined;
		return () => {
			requestSerial.current += 1;
			if (timer !== undefined) window.clearInterval(timer);
			if (queuedGeneration.current === refreshGeneration.current) queuedGeneration.current = null;
		};
	}, [refresh, session.status]);

	const filteredRecords = useMemo(
		() => trajectory.records.filter((record) => matchesTrajectoryQuery(record, query)),
		[trajectory.records, query],
	);
	const selected = trajectory.records.find((record) => record.id === selectedId) ?? null;
	const range = trajectoryRange(trajectory.records);
	const totalDuration = Math.max(0, range.end - range.start);
	const virtualizer = useVirtualizer({
		count: filteredRecords.length,
		getScrollElement: () => ledgerRef.current,
		estimateSize: () => 56,
		overscan: 10,
	});

	return (
		<section className="trajectory-region" aria-label="会话轨迹">
			<div className="trajectory-overview">
				<section className="trajectory-stats" aria-label="轨迹统计">
					<div>
						<span>时长</span>
						<strong>{formatDuration(totalDuration)}</strong>
					</div>
					<div>
						<span>轮次</span>
						<strong>{trajectory.turns}</strong>
					</div>
					<div>
						<span>调用</span>
						<strong>{trajectory.calls}</strong>
					</div>
					<div>
						<span>事件</span>
						<strong>{trajectory.records.length}</strong>
					</div>
				</section>
				<TrajectoryTimeline
					records={trajectory.records}
					matchingRecords={new Set(filteredRecords.map((record) => record.id))}
					selectedId={selectedId}
					onSelect={setSelectedId}
				/>
			</div>
			<div className="trajectory-workspace">
				<div className="trajectory-ledger">
					<div className="trajectory-toolbar">
						<label className="trajectory-search">
							<Search size={14} strokeWidth={1.8} aria-hidden="true" />
							<input
								type="search"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="搜索事件、工具或内容"
								aria-label="搜索轨迹"
							/>
						</label>
						<span className="trajectory-result-count">{filteredRecords.length} 条</span>
						<button
							className="icon-button bordered"
							type="button"
							aria-label="刷新轨迹"
							title="刷新轨迹"
							disabled={loading}
							onClick={() => void refresh(true)}
						>
							<RefreshCw className={loading ? "spin" : ""} size={14} strokeWidth={1.8} />
						</button>
					</div>
					<div className="trajectory-list" ref={ledgerRef}>
						{loading && trajectory.records.length === 0 ? (
							<div className="trajectory-state">
								<span className="pulse" />
								正在读取轨迹
							</div>
						) : error && trajectory.records.length === 0 ? (
							<div className="trajectory-state error">
								<AlertCircle size={16} strokeWidth={1.8} />
								{error}
							</div>
						) : filteredRecords.length === 0 ? (
							<div className="trajectory-state">{query ? "没有匹配的轨迹记录" : "当前会话还没有轨迹记录"}</div>
						) : (
							<div className="trajectory-virtual-list" style={{ height: `${virtualizer.getTotalSize()}px` }}>
								{virtualizer.getVirtualItems().map((item) => {
									const record = filteredRecords[item.index];
									return (
										<button
											className={`trajectory-record ${record.id === selectedId ? "selected" : ""} ${record.isError ? "error" : ""}`}
											type="button"
											key={record.id}
											data-index={item.index}
											ref={virtualizer.measureElement}
											style={{ transform: `translateY(${item.start}px)` }}
											onClick={() => setSelectedId(record.id)}
										>
											<span className={`trajectory-kind ${record.kind}`}>{kindIcon(record)}</span>
											<span className="trajectory-record-copy">
												<span>
													<strong>{record.turn ? `T${record.turn}` : "--"}</strong>
													<small>{KIND_LABELS[record.kind]}</small>
												</span>
												<b>{record.toolName || record.eventName || record.preview}</b>
												<em>{record.toolName ? record.preview : formatRecordedTime(record.timestamp)}</em>
											</span>
											<span className="trajectory-record-duration">
												{record.running ? "运行中" : formatDuration(recordDuration(record))}
											</span>
											<ChevronRight size={14} strokeWidth={1.8} />
										</button>
									);
								})}
							</div>
						)}
					</div>
				</div>
				<TrajectoryDetail record={selected} />
			</div>
		</section>
	);
}

function TrajectoryTimeline({
	records,
	matchingRecords,
	selectedId,
	onSelect,
}: {
	records: readonly TrajectoryRecord[];
	matchingRecords: ReadonlySet<string>;
	selectedId: string;
	onSelect: (recordId: string) => void;
}): JSX.Element {
	const range = trajectoryRange(records);
	const domain = Math.max(1000, range.end - range.start);
	return (
		<section className="trajectory-timeline" aria-label={`会话轨迹，共 ${records.length} 条记录`}>
			<div className="trajectory-timeline-labels" aria-hidden="true">
				<span>Input</span>
				<span>Model</span>
				<span>Tools</span>
			</div>
			<div className="trajectory-timeline-track">
				<span className="trajectory-lane lane-input" />
				<span className="trajectory-lane lane-model" />
				<span className="trajectory-lane lane-tools" />
				{records.map((record) => {
					const left = Math.max(0, Math.min(99.4, ((record.timestamp - range.start) / domain) * 100));
					const width = Math.max(0, Math.min(100 - left, (recordDuration(record) / domain) * 100));
					const style = {
						"--trajectory-lane": String(TRAJECTORY_LANE[record.kind]),
						"--trajectory-left": `${left}%`,
						"--trajectory-width": `${width}%`,
						"--trajectory-color": timelineColor(record),
					} as CSSProperties;
					return (
						<button
							className={`trajectory-span ${record.id === selectedId ? "selected" : ""} ${matchingRecords.has(record.id) ? "" : "filtered"}`}
							type="button"
							key={record.id}
							style={style}
							title={`${KIND_LABELS[record.kind]} ${record.toolName || record.preview}`}
							aria-label={`选择 ${KIND_LABELS[record.kind]} 记录`}
							onClick={() => onSelect(record.id)}
						/>
					);
				})}
			</div>
		</section>
	);
}

function TrajectoryDetail({ record }: { record: TrajectoryRecord | null }): JSX.Element {
	if (!record) {
		return (
			<aside className="trajectory-detail">
				<div className="trajectory-detail-empty">选择一条记录查看详情</div>
			</aside>
		);
	}
	return (
		<aside className="trajectory-detail" aria-live="polite">
			<header>
				<span className={`trajectory-kind ${record.kind}`}>{kindIcon(record)}</span>
				<div>
					<strong>{record.toolName || record.eventName || KIND_LABELS[record.kind]}</strong>
					<span>
						<Clock3 size={12} strokeWidth={1.8} />
						{formatRecordedTime(record.timestamp)} · {formatDuration(recordDuration(record))}
					</span>
				</div>
			</header>
			<dl className="trajectory-detail-meta">
				<div>
					<dt>范围</dt>
					<dd>{record.turn ? `Turn ${record.turn}` : "Session"}</dd>
				</div>
				<div>
					<dt>状态</dt>
					<dd>{record.running ? "Running" : record.isError ? "Error" : "Complete"}</dd>
				</div>
				{record.provider ? (
					<div>
						<dt>Provider</dt>
						<dd>{record.provider}</dd>
					</div>
				) : null}
				{record.model ? (
					<div>
						<dt>Model</dt>
						<dd>{record.model}</dd>
					</div>
				) : null}
				{record.toolCallId ? (
					<div>
						<dt>Call ID</dt>
						<dd title={record.toolCallId}>{record.toolCallId}</dd>
					</div>
				) : null}
			</dl>
			<div className="trajectory-detail-content">
				<DetailSection title="思考" value={record.thinkingText} />
				<DetailSection title="Input" value={record.requestText} />
				<DetailSection title={record.isError ? "Error" : "Output"} value={record.resultText} />
				<DetailSection title="Content" value={record.content} />
			</div>
		</aside>
	);
}

function DetailSection({ title, value }: { title: string; value?: string }): JSX.Element | null {
	if (!value?.trim()) return null;
	return (
		<section>
			<h3>{title}</h3>
			<pre>{value}</pre>
		</section>
	);
}
