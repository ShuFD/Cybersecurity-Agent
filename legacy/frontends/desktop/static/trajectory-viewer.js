(() => {
  'use strict';

  const CONTEXT_EVENTS = new Set([
    'created',
    'restored',
    'runtime-reset',
    'running',
    'cancelled',
    'error',
    'model',
    'model-error',
    'permission-mode',
    'output-timeout-retry',
    'compaction_start',
    'compaction_end',
    'auto_retry_start',
    'auto_retry_end',
    'summarization_retry_scheduled',
    'summarization_retry_attempt_start',
    'summarization_retry_finished',
  ]);
  const EVENT_LABELS = {
    created: 'Session created',
    restored: 'Session restored',
    'runtime-reset': 'Runtime reset',
    running: 'Agent started',
    cancelled: 'Run cancelled',
    error: 'Run failed',
    model: 'Model changed',
    'model-error': 'Model change failed',
    'permission-mode': 'Permission mode changed',
    'output-timeout-retry': 'Output timeout retry',
    compaction_start: 'Context compaction started',
    compaction_end: 'Context compaction finished',
    auto_retry_start: 'Automatic retry started',
    auto_retry_end: 'Automatic retry finished',
    summarization_retry_scheduled: 'Summary retry scheduled',
    summarization_retry_attempt_start: 'Summary retry started',
    summarization_retry_finished: 'Summary retry finished',
  };
  const PARTIAL_TERMINAL_EVENTS = new Set([
    'runtime-reset',
    'cancelled',
    'error',
    'closed',
    'remote-complete',
    'remote-error',
    'turn_end',
  ]);
  const KIND_LABELS = {
    system: 'SYSTEM',
    context: 'CONTEXT',
    user: 'USER',
    assistant: 'ASSISTANT',
    tool: 'TOOL',
  };
  const LANE_BY_KIND = {
    system: 0,
    context: 0,
    user: 0,
    assistant: 1,
    tool: 2,
  };
  const state = {
    open: false,
    loading: false,
    sessionId: '',
    title: '',
    payload: null,
    records: [],
    selectedId: '',
    query: '',
    requestSerial: 0,
    refreshTimer: 0,
    durationTimer: 0,
    lastFocused: null,
    hasSnapshot: false,
    logEpoch: '',
    eventCursor: 0,
    messageCursor: 0,
  };
  const dom = {};

  function byId(id) {
    return document.getElementById(id);
  }

  function node(tag, className = '', text = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function timestampMs(value, fallback = Date.now()) {
    const number = finiteNumber(value);
    if (number === null || number <= 0) return fallback;
    return number > 10_000_000_000 ? number : number * 1000;
  }

  function eventTimestamp(event, fallback = Date.now()) {
    return timestampMs(event?.timestamp ?? event?.ts, fallback);
  }

  function messageTimestamp(message, fallback = Date.now()) {
    return timestampMs(message?.ts ?? message?.timestamp, fallback);
  }

  function normalizeKind(role) {
    const value = String(role || '').toLowerCase();
    if (value === 'system') return 'system';
    if (value === 'user') return 'user';
    if (value === 'assistant') return 'assistant';
    if (value === 'toolresult' || value === 'tool') return 'tool';
    return 'context';
  }

  function textValue(value) {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch (_) {
      return String(value);
    }
  }

  function prettyText(value) {
    const text = textValue(value).trim();
    if (!text || !/^[{[]/.test(text)) return text;
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch (_) {
      return text;
    }
  }

  function compactText(value, limit = 180) {
    const text = textValue(value).replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  function formatDuration(milliseconds) {
    const duration = Math.max(0, finiteNumber(milliseconds) || 0);
    if (duration < 1000) return `${Math.round(duration)}ms`;
    const seconds = duration / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds - minutes * 60;
    if (minutes < 60) return `${minutes}m ${remainder.toFixed(1)}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  function formatRecordedTime(timestamp) {
    if (!Number.isFinite(timestamp)) return 'Unknown time';
    return new Date(timestamp).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hour12: false,
    });
  }

  function intervalRole(event) {
    return normalizeKind(event?.role);
  }

  function addInterval(map, role, interval) {
    if (!map.has(role)) map.set(role, []);
    map.get(role).push(interval);
  }

  function eventDetailText(event) {
    const parts = [];
    if (event?.level) parts.push(`Level: ${event.level}`);
    if (event?.reason) parts.push(`Reason: ${event.reason}`);
    if (event?.attempt !== undefined) {
      const maximum = event.maxAttempts === undefined ? '' : `/${event.maxAttempts}`;
      parts.push(`Attempt: ${event.attempt}${maximum}`);
    }
    if (event?.delayMs !== undefined) parts.push(`Delay: ${formatDuration(event.delayMs)}`);
    if (event?.errorMessage) parts.push(String(event.errorMessage));
    if (event?.finalError) parts.push(String(event.finalError));
    if (event?.aborted === true) parts.push('Aborted');
    if (event?.willRetry === true) parts.push('Will retry');
    return parts.join('\n');
  }

  function toolScope(turn, toolCallId) {
    return `${turn ?? 0}\u0000${toolCallId}`;
  }

  function canonicalToolKey(turn, toolCallId, occurrence) {
    return `${turn ?? 0}:${toolCallId}#${occurrence}`;
  }

  function buildRuntimeModel(events, running) {
    const ordered = [...events].sort((left, right) => {
      const time = eventTimestamp(left, 0) - eventTimestamp(right, 0);
      return time || Number(left?.id || 0) - Number(right?.id || 0);
    });
    const openMessages = new Map();
    const intervals = new Map();
    const toolRecords = [];
    const toolRecordsByKey = new Map();
    const toolKeysByScope = new Map();
    const toolKeysByRawId = new Map();
    const occurrenceByScope = new Map();
    const activeToolKeysByScope = new Map();
    const pendingEndKeysByScope = new Map();
    const completedToolKeys = new Set();
    const contextRecords = [];
    let eventTurn = 0;

    function eventTurnFor(event) {
      const explicit = finiteNumber(event?.turn ?? event?.turnIndex ?? event?.turnNumber);
      return explicit === null ? eventTurn : Math.max(0, Math.floor(explicit));
    }

    function allocateToolKey(turn, toolCallId) {
      const scope = toolScope(turn, toolCallId);
      const occurrence = (occurrenceByScope.get(scope) || 0) + 1;
      occurrenceByScope.set(scope, occurrence);
      const key = canonicalToolKey(turn, toolCallId, occurrence);
      const scoped = toolKeysByScope.get(scope) || [];
      scoped.push(key);
      toolKeysByScope.set(scope, scoped);
      const raw = toolKeysByRawId.get(toolCallId) || [];
      raw.push(key);
      toolKeysByRawId.set(toolCallId, raw);
      return key;
    }

    function resolveToolStart(turn, toolCallId) {
      const scope = toolScope(turn, toolCallId);
      const pending = pendingEndKeysByScope.get(scope);
      const key = pending?.shift() || allocateToolKey(turn, toolCallId);
      if (pending && pending.length === 0) pendingEndKeysByScope.delete(scope);
      const active = activeToolKeysByScope.get(scope) || [];
      active.push(key);
      activeToolKeysByScope.set(scope, active);
      return key;
    }

    function resolveToolEnd(turn, toolCallId) {
      const scope = toolScope(turn, toolCallId);
      const active = activeToolKeysByScope.get(scope);
      if (active?.length) {
        const key = active.shift();
        if (active.length === 0) activeToolKeysByScope.delete(scope);
        return key;
      }
      const key = allocateToolKey(turn, toolCallId);
      const pending = pendingEndKeysByScope.get(scope) || [];
      pending.push(key);
      pendingEndKeysByScope.set(scope, pending);
      return key;
    }

    function ensureToolRecord(key, toolCallId, turn, event, timestamp, order) {
      const existing = toolRecordsByKey.get(key);
      if (existing) return existing;
      const record = {
        id: `tool:${key}`,
        kind: 'tool',
        label: KIND_LABELS.tool,
        timestamp,
        endTimestamp: timestamp,
        turn: turn || null,
        order,
        toolCallId,
        toolName: String(event?.toolName || 'tool'),
        requestText: '',
        resultText: '',
        content: '',
        preview: 'Tool call',
        isError: false,
        running: false,
        source: 'runtime',
      };
      toolRecords.push(record);
      toolRecordsByKey.set(key, record);
      return record;
    }

    function applyToolStart(event, timestamp, order, index) {
      const toolCallId = String(event?.toolCallId || `event-${event?.id || index}`);
      const turn = eventTurnFor(event);
      const key = resolveToolStart(turn, toolCallId);
      const record = ensureToolRecord(key, toolCallId, turn, event, timestamp, order);
      record.timestamp = Math.min(record.timestamp, timestamp);
      record.order = Math.min(record.order, order);
      record.turn = record.turn || (turn || null);
      record.toolName = String(event?.toolName || record.toolName || 'tool');
      const requestText = prettyText(event?.argsText || '');
      if (requestText) record.requestText = requestText;
      record.content = `${record.toolName}\n${record.requestText}`.trim();
      record.preview = compactText(record.requestText || record.resultText || 'Tool call');
      if (!completedToolKeys.has(key)) {
        record.running = running;
        record.endTimestamp = running ? Math.max(record.endTimestamp, Date.now()) : record.timestamp;
      }
    }

    function applyToolEnd(event, timestamp, order, index) {
      const toolCallId = String(event?.toolCallId || `event-${event?.id || index}`);
      const turn = eventTurnFor(event);
      const key = resolveToolEnd(turn, toolCallId);
      const record = ensureToolRecord(key, toolCallId, turn, event, timestamp, order);
      completedToolKeys.add(key);
      record.timestamp = Math.min(record.timestamp, timestamp);
      record.endTimestamp = Math.max(record.endTimestamp, timestamp);
      record.order = Math.min(record.order, order);
      record.turn = record.turn || (turn || null);
      record.toolName = String(event?.toolName || record.toolName || 'tool');
      const resultText = prettyText(event?.resultText || '');
      if (resultText) record.resultText = resultText;
      record.content = `${record.toolName}\n${record.requestText}`.trim() || record.resultText || 'Tool result';
      record.preview = compactText(record.requestText || record.resultText || 'Tool result');
      record.isError = record.isError || event?.isError === true;
      record.running = false;
    }

    for (const [index, event] of ordered.entries()) {
      const timestamp = eventTimestamp(event);
      const eventName = String(event?.event || 'event');
      if (eventName === 'turn_start') eventTurn += 1;

      if (eventName === 'message_start') {
        const role = intervalRole(event);
        if (!openMessages.has(role)) openMessages.set(role, []);
        openMessages.get(role).push({ timestamp, turn: eventTurn });
        continue;
      }
      if (eventName === 'message_end') {
        const role = intervalRole(event);
        const start = openMessages.get(role)?.shift();
        addInterval(intervals, role, {
          start: start?.timestamp ?? timestamp,
          end: timestamp,
          turn: start?.turn || eventTurn,
        });
        continue;
      }
      if (eventName === 'tool_execution_start') {
        applyToolStart(event, timestamp, Number(event?.id || index), index);
        continue;
      }
      if (eventName === 'tool_execution_end') {
        applyToolEnd(event, timestamp, Number(event?.id || index), index);
        continue;
      }
      if (CONTEXT_EVENTS.has(eventName)) {
        const detail = eventDetailText(event);
        contextRecords.push({
          id: `event:${event?.id || index}:${eventName}`,
          kind: eventName === 'error' || eventName === 'model-error' ? 'system' : 'context',
          label: eventName === 'error' || eventName === 'model-error' ? KIND_LABELS.system : KIND_LABELS.context,
          timestamp,
          endTimestamp: timestamp,
          turn: eventTurn || null,
          order: Number(event?.id || index),
          content: detail || EVENT_LABELS[eventName] || eventName,
          preview: detail ? `${EVENT_LABELS[eventName] || eventName}: ${compactText(detail, 120)}` : (EVENT_LABELS[eventName] || eventName),
          eventName,
          isError: eventName === 'error' || eventName === 'model-error',
          running: false,
          source: 'runtime',
        });
      }
    }

    for (const entries of intervals.values()) entries.sort((left, right) => left.start - right.start);
    for (const record of toolRecords) {
      if (!record.turn) record.turn = eventTurn || null;
      if (!record.content) record.content = `${record.toolName}\n${record.requestText}`.trim() || record.resultText || 'Tool result';
      if (!record.preview) record.preview = compactText(record.requestText || record.resultText || (record.running ? 'Tool call in progress' : 'Tool result'));
    }
    return {
      intervals,
      toolRecords,
      toolRecordsByKey,
      toolKeysByScope,
      toolKeysByRawId,
      completedToolKeys,
      contextRecords,
      eventTurn,
    };
  }

  function turnAt(timestamp, userTimestamps) {
    let turn = 0;
    for (const userTimestamp of userTimestamps) {
      if (userTimestamp > timestamp) break;
      turn += 1;
    }
    return turn || null;
  }

  function buildRecords(payload) {
    const messages = [...asArray(payload?.messages)];
    if (payload?.partial) {
      const partialIndex = messages.findIndex((message) => message?.id === payload.partial?.id);
      if (partialIndex >= 0) {
        // 托管会话会同时返回同 ID 的流式记录和 `partial`，以后者覆盖前者。
        messages[partialIndex] = { ...messages[partialIndex], ...payload.partial, partial: true };
      } else {
        messages.push({ ...payload.partial, partial: true });
      }
    }
    const sessionCreatedAt = timestampMs(payload?.session?.createdAt, Date.now());
    messages.sort((left, right) => {
      const time = messageTimestamp(left, sessionCreatedAt) - messageTimestamp(right, sessionCreatedAt);
      return time || Number(left?.id || 0) - Number(right?.id || 0);
    });
    const running = payload?.session?.status === 'running';
    const runtime = buildRuntimeModel(asArray(payload?.events), running);
    const messageRecords = [];
    const transcriptCallQueues = new Map();
    const transcriptPendingResults = new Map();
    const transcriptCallOccurrences = new Map();
    const transcriptResultOccurrences = new Map();
    const completedToolKeys = new Set(runtime.completedToolKeys);
    const claimedRuntimeKeys = new Set();
    const userTimestamps = messages
      .filter((message) => normalizeKind(message?.role) === 'user')
      .map((message, index) => messageTimestamp(message, sessionCreatedAt + index));
    let messageTurn = 0;

    function runtimeToolCandidates(toolCallId, turn) {
      if (turn !== null) {
        const scoped = runtime.toolKeysByScope.get(toolScope(turn, toolCallId));
        if (scoped && scoped.length > 0) return scoped;
      }
      return runtime.toolKeysByRawId.get(toolCallId) || [];
    }

    function selectRuntimeToolKey(candidates, preferredIndex) {
      const preferred = candidates[preferredIndex];
      if (preferred && !claimedRuntimeKeys.has(preferred)) return preferred;
      return candidates.find((candidate) => !claimedRuntimeKeys.has(candidate));
    }

    function transcriptToolKeyForCall(toolCallId, turn) {
      const scope = toolScope(turn, toolCallId);
      const pending = transcriptPendingResults.get(scope);
      const reordered = pending?.shift();
      if (pending && pending.length === 0) transcriptPendingResults.delete(scope);
      const occurrence = (transcriptCallOccurrences.get(scope) || 0) + 1;
      transcriptCallOccurrences.set(scope, occurrence);
      const candidates = runtimeToolCandidates(toolCallId, turn);
      const key = reordered || selectRuntimeToolKey(candidates, occurrence - 1) || canonicalToolKey(turn, toolCallId, occurrence);
      if (runtime.toolRecordsByKey.has(key)) claimedRuntimeKeys.add(key);
      const queue = transcriptCallQueues.get(scope) || [];
      queue.push(key);
      transcriptCallQueues.set(scope, queue);
      return key;
    }

    function transcriptToolKeyForResult(toolCallId, turn) {
      const scope = toolScope(turn, toolCallId);
      const callQueue = transcriptCallQueues.get(scope);
      const fromCall = callQueue?.shift();
      if (callQueue && callQueue.length === 0) transcriptCallQueues.delete(scope);
      if (fromCall) return fromCall;
      const occurrence = (transcriptResultOccurrences.get(scope) || 0) + 1;
      transcriptResultOccurrences.set(scope, occurrence);
      const candidates = runtimeToolCandidates(toolCallId, turn);
      const key = selectRuntimeToolKey(candidates, occurrence - 1) || canonicalToolKey(turn, toolCallId, occurrence);
      if (runtime.toolRecordsByKey.has(key)) claimedRuntimeKeys.add(key);
      const pending = transcriptPendingResults.get(scope) || [];
      pending.push(key);
      transcriptPendingResults.set(scope, pending);
      return key;
    }

    function mergeTranscriptTool(toolKey, toolCallId, patch) {
      let record = runtime.toolRecordsByKey.get(toolKey);
      if (!record) {
        record = {
          id: `tool:${toolKey}`,
          kind: 'tool',
          label: KIND_LABELS.tool,
          timestamp: patch.timestamp,
          endTimestamp: patch.timestamp,
          turn: patch.turn,
          order: patch.order,
          toolCallId,
          toolName: patch.toolName || 'tool',
          requestText: '',
          resultText: '',
          content: '',
          preview: 'Tool call',
          isError: false,
          running: patch.running,
          source: 'message',
        };
        runtime.toolRecords.push(record);
        runtime.toolRecordsByKey.set(toolKey, record);
      }
      record.timestamp = Math.min(record.timestamp, patch.timestamp);
      record.endTimestamp = Math.max(record.endTimestamp || patch.timestamp, patch.timestamp);
      record.order = Math.min(record.order, patch.order);
      record.turn = record.turn || patch.turn;
      if (patch.toolName) record.toolName = patch.toolName;
      if (patch.requestText) record.requestText = patch.requestText;
      if (patch.resultText) record.resultText = patch.resultText;
      record.isError = record.isError || patch.isError === true;
      if (patch.hasEnd || patch.hasResult) completedToolKeys.add(toolKey);
      record.running = completedToolKeys.has(toolKey) ? false : patch.running;
      record.content = `${record.toolName || 'tool'}\n${record.requestText || ''}`.trim() || record.resultText || 'Tool result';
      record.preview = compactText(record.requestText || record.resultText || (record.running ? 'Tool call in progress' : 'Tool result'));
      return record;
    }

    for (const [index, message] of messages.entries()) {
      const kind = normalizeKind(message?.role);
      const timestamp = messageTimestamp(message, sessionCreatedAt + index);
      if (kind === 'user') messageTurn += 1;

      for (const [toolIndex, call] of asArray(message?.toolCalls).entries()) {
        const toolCallId = String(call?.id || `message-${message?.id || index}-${toolIndex}`);
        const turn = messageTurn || turnAt(timestamp, userTimestamps);
        const key = transcriptToolKeyForCall(toolCallId, turn);
        mergeTranscriptTool(key, toolCallId, {
          timestamp: timestamp + toolIndex / 10,
          order: Number(message?.id || index) + (toolIndex + 1) / 100,
          turn,
          toolName: String(call?.name || call?.toolName || 'tool'),
          requestText: prettyText(call?.argsText || call?.arguments || call?.args || call?.input || ''),
          running: message?.partial === true || running,
          hasStart: true,
        });
      }

      if (kind === 'tool') {
        const toolCallId = String(message?.toolCallId || message?.tool_call_id || `result-${message?.id || index}`);
        const turn = messageTurn || turnAt(timestamp, userTimestamps);
        const key = transcriptToolKeyForResult(toolCallId, turn);
        mergeTranscriptTool(key, toolCallId, {
          timestamp,
          order: Number(message?.id || index),
          turn,
          toolName: String(message?.toolName || message?.tool_name || 'tool'),
          resultText: prettyText(message?.content || message?.result || message?.output || ''),
          isError: message?.isError === true,
          running: false,
          hasEnd: true,
          hasResult: true,
        });
        continue;
      }

      const interval = runtime.intervals.get(kind)?.shift();
      const content = textValue(message?.content);
      const record = {
        id: `message:${message?.id ?? index}:${kind}`,
        kind,
        label: KIND_LABELS[kind],
        timestamp: interval?.start ?? timestamp,
        endTimestamp: interval?.end ?? timestamp,
        turn: kind === 'system' || (kind === 'context' && messageTurn === 0) ? null : (messageTurn || interval?.turn || null),
        order: Number(message?.id || index),
        content,
        preview: compactText(content) || (message?.partial ? 'Streaming response' : 'Empty message'),
        provider: typeof message?.provider === 'string' ? message.provider : '',
        model: typeof message?.model === 'string' ? message.model : '',
        isError: message?.isError === true || message?.stopReason === 'error',
        running: message?.partial === true,
        source: 'message',
      };
      if (record.running) record.endTimestamp = Date.now();
      messageRecords.push(record);
    }

    for (const record of runtime.toolRecords) {
      if (!record.turn) record.turn = turnAt(record.timestamp, userTimestamps);
    }
    for (const record of runtime.contextRecords) {
      if (!record.turn) record.turn = turnAt(record.timestamp, userTimestamps);
    }

    const records = [...messageRecords, ...runtime.toolRecords, ...runtime.contextRecords];
    records.sort((left, right) => {
      const time = left.timestamp - right.timestamp;
      if (time) return time;
      const order = Number(left.order || 0) - Number(right.order || 0);
      if (order) return order;
      return LANE_BY_KIND[left.kind] - LANE_BY_KIND[right.kind];
    });
    return {
      records,
      turns: Math.max(userTimestamps.length, runtime.eventTurn),
      calls: runtime.toolRecords.length,
    };
  }

  function toolRecords(payload) {
    return buildRecords(payload).records.filter((record) => record.kind === 'tool');
  }

  function recordDuration(record) {
    const end = record.running ? Date.now() : record.endTimestamp;
    return Math.max(0, (finiteNumber(end) || record.timestamp) - record.timestamp);
  }

  function trajectoryRange(records) {
    if (!records.length) return { start: Date.now(), end: Date.now() };
    return {
      start: Math.min(...records.map((record) => record.timestamp)),
      end: Math.max(...records.map((record) => record.running ? Date.now() : (record.endTimestamp || record.timestamp))),
    };
  }

  function searchableText(record) {
    return [
      record.label,
      record.kind,
      record.content,
      record.preview,
      record.toolName,
      record.requestText,
      record.resultText,
      record.provider,
      record.model,
      record.eventName,
      record.turn,
    ].filter((value) => value !== undefined && value !== null).join('\n').toLowerCase();
  }

  function filteredRecords() {
    const query = state.query.trim().toLowerCase();
    if (!query) return state.records;
    return state.records.filter((record) => searchableText(record).includes(query));
  }

  function setStatus(message, visible = true) {
    if (!dom.loading) return;
    dom.loading.textContent = message;
    dom.loading.classList.toggle('hidden', !visible);
  }

  function renderStats() {
    const range = trajectoryRange(state.records);
    const duration = Math.max(0, range.end - range.start);
    if (dom.duration) dom.duration.textContent = formatDuration(duration);
    if (dom.turns) dom.turns.textContent = String(state.payload?.trajectory?.turns || 0);
    if (dom.calls) dom.calls.textContent = String(state.payload?.trajectory?.calls || 0);
  }

  function timelineColor(record) {
    if (record.isError) return 'var(--err)';
    if (record.kind === 'assistant') return 'color-mix(in srgb, #d96991 72%, var(--text))';
    if (record.kind === 'tool') return 'var(--warn)';
    if (record.kind === 'context') return 'var(--ok)';
    if (record.kind === 'user') return 'var(--accent)';
    return 'var(--text-muted)';
  }

  function renderTimeline() {
    if (!dom.timelineSpans || !dom.timelineTrack) return;
    dom.timelineSpans.replaceChildren();
    const range = trajectoryRange(state.records);
    const domain = Math.max(1000, range.end - range.start);
    const matching = new Set(filteredRecords().map((record) => record.id));
    const fragment = document.createDocumentFragment();

    for (const record of state.records) {
      const span = node('button', 'trajectory-timeline-span');
      span.type = 'button';
      span.dataset.recordId = record.id;
      span.classList.toggle('selected', record.id === state.selectedId);
      span.classList.toggle('filtered-out', !matching.has(record.id));
      const rawLeft = ((record.timestamp - range.start) / domain) * 100;
      const left = Math.max(0, Math.min(99.4, rawLeft));
      const rawWidth = (recordDuration(record) / domain) * 100;
      const width = Math.max(0, Math.min(100 - left, rawWidth));
      span.style.setProperty('--trajectory-lane', String(LANE_BY_KIND[record.kind]));
      span.style.setProperty('--trajectory-left', `${left}%`);
      span.style.setProperty('--trajectory-width', `${width}%`);
      span.style.setProperty('--trajectory-color', timelineColor(record));
      const duration = recordDuration(record);
      const label = `${record.label} ${record.toolName || compactText(record.preview, 80)}，${formatRecordedTime(record.timestamp)}${duration ? `，${formatDuration(duration)}` : ''}`;
      span.title = label;
      span.setAttribute('aria-label', label);
      fragment.appendChild(span);
    }
    dom.timelineSpans.appendChild(fragment);
    dom.timelineTrack.setAttribute(
      'aria-label',
      state.records.length ? `会话轨迹，共 ${state.records.length} 条记录，时长 ${formatDuration(domain)}` : '当前会话没有轨迹记录',
    );
  }

  function kindBadge(record) {
    const badge = node('span', 'trajectory-kind-badge', record.label);
    badge.dataset.kind = record.kind;
    return badge;
  }

  function renderRecords() {
    if (!dom.records) return;
    const records = filteredRecords();
    dom.records.replaceChildren();
    if (!records.length) {
      setStatus(state.query ? '没有匹配的轨迹记录。' : '当前会话还没有轨迹记录。');
      renderTimeline();
      renderDetail();
      return;
    }
    setStatus('', false);
    const fragment = document.createDocumentFragment();
    for (const record of records) {
      const row = node('tr', 'trajectory-record');
      row.dataset.recordId = record.id;
      row.tabIndex = 0;
      row.classList.toggle('selected', record.id === state.selectedId);
      row.classList.toggle('error', record.isError);
      row.setAttribute('aria-selected', String(record.id === state.selectedId));

      const eventCell = node('td');
      const eventWrap = node('div', 'trajectory-event-cell');
      eventWrap.appendChild(node('span', 'trajectory-turn-number', record.turn ? `T${record.turn}` : '—'));
      eventWrap.appendChild(kindBadge(record));
      eventCell.appendChild(eventWrap);

      const contentCell = node('td');
      const preview = node('div', 'trajectory-record-preview');
      if (record.toolName) preview.appendChild(node('strong', '', record.toolName));
      preview.appendChild(document.createTextNode(record.preview));
      contentCell.appendChild(preview);

      const duration = recordDuration(record);
      const timeCell = node('td', 'trajectory-record-time', duration ? formatDuration(duration) : formatRecordedTime(record.timestamp));
      row.append(eventCell, contentCell, timeCell);
      fragment.appendChild(row);
    }
    dom.records.appendChild(fragment);
    renderTimeline();
    renderDetail();
  }

  function detailSection(title, value) {
    const text = prettyText(value);
    if (!text) return null;
    const section = node('section', 'trajectory-detail-section');
    section.appendChild(node('h4', '', title));
    section.appendChild(node('pre', '', text));
    return section;
  }

  function renderDetail() {
    if (!dom.detail) return;
    dom.detail.replaceChildren();
    const record = state.records.find((item) => item.id === state.selectedId);
    if (!record) {
      dom.detail.appendChild(node('div', 'trajectory-detail-empty', '选择一条记录查看详情。'));
      return;
    }
    const head = node('header', 'trajectory-detail-head');
    head.appendChild(kindBadge(record));
    head.appendChild(node('h3', '', record.toolName || record.eventName || `${record.label} record`));
    head.appendChild(node('p', '', `${formatRecordedTime(record.timestamp)} · ${formatDuration(recordDuration(record))}`));
    dom.detail.appendChild(head);

    const metadata = node('dl', 'trajectory-detail-meta');
    const entries = [
      ['Turn', record.turn ? `Turn ${record.turn}` : 'Session'],
      ['Status', record.running ? 'Running' : (record.isError ? 'Error' : 'Complete')],
      ['Source', record.source || 'Unknown'],
      ['Provider', record.provider],
      ['Model', record.model],
      ['Call ID', record.toolCallId],
    ].filter((entry) => entry[1]);
    for (const [key, value] of entries) {
      metadata.appendChild(node('dt', '', key));
      metadata.appendChild(node('dd', '', String(value)));
    }
    dom.detail.appendChild(metadata);

    const request = detailSection('Request', record.requestText);
    const response = detailSection(record.isError ? 'Error' : 'Response', record.resultText);
    const content = detailSection('Content', record.content);
    if (request) dom.detail.appendChild(request);
    if (response) dom.detail.appendChild(response);
    if (content && (!request || record.content !== record.requestText)) dom.detail.appendChild(content);
  }

  function selectRecord(recordId, focusRow = false) {
    if (!state.records.some((record) => record.id === recordId)) return;
    state.selectedId = recordId;
    renderRecords();
    if (!focusRow) return;
    const row = [...dom.records.querySelectorAll('.trajectory-record')]
      .find((candidate) => candidate.dataset.recordId === recordId);
    row?.scrollIntoView({ block: 'nearest' });
    row?.focus({ preventScroll: true });
  }

  function runtimeEventKey(event) {
    if (event && event.id !== undefined && event.id !== null) return `id:${event.id}`;
    try { return `value:${JSON.stringify(event)}`; } catch (_) { return `value:${String(event)}`; }
  }

  function maxMessageCursor(messages) {
    return asArray(messages).reduce((cursor, message) => {
      const id = Number(message?.id);
      return Number.isSafeInteger(id) && id > cursor ? id : cursor;
    }, 0);
  }

  function maxEventCursor(events) {
    return asArray(events).reduce((cursor, event) => {
      const id = Number(event?.id);
      return Number.isSafeInteger(id) && id > cursor ? id : cursor;
    }, 0);
  }

  function lightDeltaClearsPartial(payload) {
    const status = String(payload?.session?.status || '').toLowerCase();
    if (status !== 'running' && status !== 'paused') return true;
    return asArray(payload?.events).some((event) => {
      const name = String(event?.event || '').trim().toLowerCase();
      if (PARTIAL_TERMINAL_EVENTS.has(name)) return true;
      if (name !== 'message_end') return false;
      const role = String(event?.role || '').trim().toLowerCase();
      return role === 'assistant' || role === '';
    });
  }

  function mergeRuntimeLogPayload(previous, next) {
    if (
      !previous
      || !next
      || next.incremental !== true
      || next.resetRequired === true
      || previous.sessionId !== next.sessionId
      || (previous.logEpoch !== undefined && next.logEpoch !== undefined && previous.logEpoch !== next.logEpoch)
    ) {
      return next;
    }

    const messagesIncluded = next.messagesIncluded !== false;
    const messagesById = new Map();
    for (const message of asArray(previous.messages)) {
      const key = message?.id === undefined || message?.id === null
        ? `value:${JSON.stringify(message)}`
        : `id:${message.id}`;
      messagesById.set(key, message);
    }
    if (messagesIncluded) {
      for (const message of asArray(next.messages)) {
        const key = message?.id === undefined || message?.id === null
          ? `value:${JSON.stringify(message)}`
          : `id:${message.id}`;
        messagesById.set(key, message);
      }
    }

    const eventsByKey = new Map();
    for (const event of asArray(previous.events)) eventsByKey.set(runtimeEventKey(event), event);
    for (const event of asArray(next.events)) eventsByKey.set(runtimeEventKey(event), event);
    const events = [...eventsByKey.values()].sort((left, right) => {
      const leftId = Number(left?.id);
      const rightId = Number(right?.id);
      if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) return leftId - rightId;
      return eventTimestamp(left, 0) - eventTimestamp(right, 0);
    });
    const messages = [...messagesById.values()].sort((left, right) => {
      const leftId = Number(left?.id);
      const rightId = Number(right?.id);
      if (Number.isFinite(leftId) && Number.isFinite(rightId)) return leftId - rightId;
      return messageTimestamp(left, 0) - messageTimestamp(right, 0);
    });
    const partial = messagesIncluded
      ? (next.partial || null)
      : (next.partial || (lightDeltaClearsPartial(next) ? null : (previous.partial || null)));
    return {
      ...previous,
      ...next,
      messages: messagesIncluded ? messages : asArray(previous.messages),
      partial,
      events,
      messageCursor: next.messageCursor ?? maxMessageCursor(messages),
      eventCursor: next.eventCursor ?? maxEventCursor(events),
      logEpoch: next.logEpoch ?? previous.logEpoch,
      messagesIncluded: messagesIncluded || previous.messagesIncluded === true,
    };
  }

  async function refresh() {
    if (!state.open || !state.sessionId || state.loading) return;
    const serial = ++state.requestSerial;
    state.loading = true;
    if (dom.refresh) dom.refresh.disabled = true;
    setStatus('正在读取轨迹…');
    try {
      const request = { sessionId: state.sessionId };
      if (state.hasSnapshot) {
        request.incremental = true;
        request.afterEventId = state.eventCursor;
        request.afterMessageId = state.messageCursor;
        // 只请求消息增量，同时保持流式 partial 和已完成工具结果同步。
        request.includeMessages = true;
        if (state.logEpoch) request.logEpoch = state.logEpoch;
      }
      const incoming = await window.secheurAgent.rpc('session/runtime/log', request);
      if (!state.open || serial !== state.requestSerial) return;
      if (incoming?.error) throw new Error(incoming.error.message || incoming.error);
      const payload = mergeRuntimeLogPayload(state.hasSnapshot ? state.payload : null, incoming || {});
      const trajectory = buildRecords(payload || {});
      state.payload = { ...payload, trajectory };
      state.records = trajectory.records;
      state.logEpoch = typeof payload?.logEpoch === 'string' ? payload.logEpoch : '';
      state.eventCursor = Number.isSafeInteger(Number(payload?.eventCursor))
        ? Number(payload.eventCursor)
        : maxEventCursor(payload?.events);
      state.messageCursor = Number.isSafeInteger(Number(payload?.messageCursor))
        ? Number(payload.messageCursor)
        : maxMessageCursor(payload?.messages);
      state.hasSnapshot = true;
      if (!state.records.some((record) => record.id === state.selectedId)) {
        state.selectedId = state.records.at(-1)?.id || '';
      }
      renderStats();
      renderRecords();
    } catch (error) {
      if (!state.open || serial !== state.requestSerial) return;
      setStatus(`轨迹读取失败：${error?.message || error}`);
    } finally {
      if (serial === state.requestSerial) {
        state.loading = false;
        if (dom.refresh) dom.refresh.disabled = false;
      }
    }
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    state.requestSerial += 1;
    window.clearTimeout(state.refreshTimer);
    window.clearInterval(state.durationTimer);
    state.refreshTimer = 0;
    state.durationTimer = 0;
    dom.viewer.classList.add('hidden');
    dom.viewer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('trajectory-viewer-open');
    const canRestoreFocus = state.lastFocused instanceof HTMLElement
      && state.lastFocused.isConnected
      && !dom.viewer.contains(state.lastFocused)
      && state.lastFocused.matches('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const focusTarget = canRestoreFocus ? state.lastFocused : dom.trigger;
    focusTarget?.focus({ preventScroll: true });
  }

  async function open(options = {}) {
    const sessionId = String(options.sessionId || '').trim();
    if (!sessionId) throw new Error('缺少会话 ID，无法读取轨迹');
    state.lastFocused = document.activeElement;
    state.open = true;
    state.sessionId = sessionId;
    state.title = String(options.title || sessionId);
    state.payload = null;
    state.records = [];
    state.selectedId = '';
    state.query = '';
    state.hasSnapshot = false;
    state.logEpoch = '';
    state.eventCursor = 0;
    state.messageCursor = 0;
    if (dom.search) dom.search.value = '';
    if (dom.subtitle) dom.subtitle.textContent = state.title;
    dom.viewer.classList.remove('hidden');
    dom.viewer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('trajectory-viewer-open');
    renderStats();
    renderRecords();
    state.durationTimer = window.setInterval(renderStats, 1000);
    await refresh();
    dom.search?.focus({ preventScroll: true });
  }

  function scheduleRefresh(notification) {
    if (!state.open || String(notification?.sessionId || '') !== state.sessionId) return;
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => {
      state.refreshTimer = 0;
      refresh();
    }, 220);
  }

  function start() {
    dom.viewer = byId('trajectory-viewer');
    dom.trigger = byId('trajectory-viewer-trigger');
    dom.subtitle = byId('trajectory-viewer-subtitle');
    dom.duration = byId('trajectory-stat-duration');
    dom.turns = byId('trajectory-stat-turns');
    dom.calls = byId('trajectory-stat-calls');
    dom.search = byId('trajectory-search-input');
    dom.refresh = byId('trajectory-refresh');
    dom.close = byId('trajectory-close');
    dom.timelineTrack = byId('trajectory-timeline-track');
    dom.timelineSpans = byId('trajectory-timeline-spans');
    dom.loading = byId('trajectory-loading');
    dom.records = byId('trajectory-records');
    dom.detail = byId('trajectory-detail');
    if (!dom.viewer || !dom.trigger || !dom.records || !dom.detail) return;

    dom.close?.addEventListener('click', close);
    dom.refresh?.addEventListener('click', refresh);
    dom.search?.addEventListener('input', () => {
      state.query = dom.search.value;
      const matches = filteredRecords();
      if (state.selectedId && !matches.some((record) => record.id === state.selectedId)) {
        state.selectedId = matches[0]?.id || '';
      }
      renderRecords();
    });
    dom.records.addEventListener('click', (event) => {
      const row = event.target.closest('.trajectory-record');
      if (row?.dataset.recordId) selectRecord(row.dataset.recordId);
    });
    dom.records.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const row = event.target.closest('.trajectory-record');
      if (!row?.dataset.recordId) return;
      event.preventDefault();
      selectRecord(row.dataset.recordId);
    });
    dom.timelineSpans?.addEventListener('click', (event) => {
      const span = event.target.closest('.trajectory-timeline-span');
      if (span?.dataset.recordId) selectRecord(span.dataset.recordId, true);
    });
    document.addEventListener('keydown', (event) => {
      if (!state.open || event.key !== 'Escape') return;
      event.preventDefault();
      close();
    });
    window.secheurAgent?.onBridgeNotification?.(scheduleRefresh);
  }

  Object.defineProperty(window, 'SecHeurTrajectoryViewer', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({ open, close, refresh, toolRecords, mergeRuntimeLogPayload }),
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
