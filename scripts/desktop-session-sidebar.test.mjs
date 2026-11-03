import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const source = readFileSync(new URL("../legacy/frontends/desktop/static/app.js", import.meta.url), "utf8");

function load(context, ...names) {
	for (const name of names) {
		const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
		assert.notEqual(start, -1, name);
		runInContext(source.slice(start, source.indexOf("\n}", start) + 2), context);
	}
}

function fixture() {
	const storage = new Map();
	const storageApi = {
		getItem: (key) => storage.get(key) ?? null,
		setItem: (key, value) => storage.set(key, value),
	};
	const state = {
		activeId: null,
		sessionSelectionVersion: 0,
		bridgeReady: true,
		managedBridge: false,
		defaultConfig: {},
		sessions: new Map(),
		solverSessions: new Map(),
		runtimeBySessionId: new Map(),
		sessionPositions: new Map(),
		nextSessionPosition: 0,
		closedSessionIds: new Set(),
		closedBridgeSessionIds: new Set(),
	};
	const noop = () => {};
	const context = createContext({
		state,
		localStorage: storageApi,
		sessionStorage: storageApi,
		console,
		_domCache: new Map(),
		sessionTitleEl: null,
		sessionListRefreshPromise: null,
		_bootstrappingSession: false,
		SESSION_HISTORY_BOOTSTRAP_LIMIT: 200,
		SESSION_HISTORY_FULL_LIMIT: 0,
		bridgeApi: { rpc: async () => ({ sessions: [] }) },
		$: () => null,
		getCwd: async () => "/workspace",
		sessionConfigPayload: (config) => config,
		getActiveConfig: () => ({}),
		syncComposerApiModelFromSelectedProfile: noop,
		renderSessionList: noop,
		renderSolverList: noop,
		getSessionRuntime: (session) => {
			if (!state.runtimeBySessionId.has(session.id)) state.runtimeBySessionId.set(session.id, {});
			return state.runtimeBySessionId.get(session.id);
		},
		getActiveSessionRuntime: () => null,
		isActiveSession: (session) => session?.id === state.activeId,
		setActiveSession: (id) => {
			state.activeId = id;
			state.sessionSelectionVersion += 1;
		},
		setBusy: noop,
		setStatus: noop,
		hideError: noop,
		showError: assert.fail,
		updateBridgeNotice: noop,
		addDiagnostic: noop,
		hydrateSessionMessages: async () => {},
		pollSessionMessages: noop,
		wakeSessionPoll: noop,
		scheduleConversationToolSync: noop,
		scheduleSolverListRender: noop,
		startPersistedSessionRefresh: noop,
		loadWorklist: noop,
		startWorklistRefresh: noop,
		updateSendButton: noop,
		loadModelProfiles: noop,
	});
	load(
		context,
		"bridgeSessionIdFromPayload", "findSessionByBridgeId", "isClosedSessionId", "isClosedBridgeSessionId",
		"isOfflineSelfTestSessionSnapshot", "shouldIgnoreBridgeSessionSnapshot", "isUntitledSessionTitle",
		"sessionOrderKey", "recordSessionPosition", "forgetSessionPosition", "initializeSessionOrder",
		"persistSessionOrder", "sortSessionsByPosition", "applyBridgeSessionSnapshot", "createLocalSession",
		"upsertLocalSessionForBridgeSession", "reorderSession", "refreshPersistedSessions", "markBridgeReady",
		"newSession", "activateCommandSession", "rememberSolverSnapshot", "ensureSessionForBridgeNotification", "handleNotification",
	);
	return context;
}

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

function order(context) {
	return [...context.state.sessions.values()].map((session) => session.bridgeSessionId);
}

test("background snapshots and periodic refresh preserve order and selection", async () => {
	const context = fixture();
	const updatedAt = Date.now() / 1000 + 1000;
	context.initializeSessionOrder([{ id: "a" }, { id: "b" }]);
	const a = context.upsertLocalSessionForBridgeSession({ id: "a", updatedAt: 10 });
	context.upsertLocalSessionForBridgeSession({ id: "b", updatedAt: 20 });
	context.state.activeId = a.id;
	context.bridgeApi.rpc = async () => ({ sessions: [
		{ id: "b", updatedAt, status: "running" },
		{ id: "a", updatedAt: 30, status: "idle" },
	], activeSessionId: "b" });
	for (let index = 0; index < 20; index += 1) {
		await context.refreshPersistedSessions();
		context.sortSessionsByPosition();
		assert.deepEqual(order(context), ["a", "b"]);
		assert.equal(context.state.activeId, a.id);
	}
	assert.equal(context.findSessionByBridgeId("b").updatedAt, updatedAt);
});

test("two conversations keep their positions through interleaved tool calls and reversed server lists", async () => {
	const context = fixture();
	context.initializeSessionOrder([{ id: "a" }, { id: "b" }]);
	const a = context.upsertLocalSessionForBridgeSession({ id: "a", title: "Conversation A" });
	const b = context.upsertLocalSessionForBridgeSession({ id: "b", title: "Conversation B" });
	context.state.activeId = a.id;
	const positions = [...context.state.sessionPositions];
	const updatedAt = Date.now() / 1000;
	for (let index = 0; index < 100; index += 1) {
		const sessionId = index % 2 ? "a" : "b";
		context.handleNotification({
			type: "session-state", sessionId, role: "main", state: "running", status: "running",
			event: index % 4 < 2 ? "tool_execution_start" : "tool_execution_end", updatedAt: updatedAt + index,
		});
		context.bridgeApi.rpc = async () => ({ sessions: index % 2
			? [{ id: "b", status: "running", updatedAt: updatedAt + index }, { id: "a", status: "running" }]
			: [{ id: "a", status: "running", updatedAt: updatedAt + index }, { id: "b", status: "running" }],
			activeSessionId: sessionId });
		await context.refreshPersistedSessions();
		context.sortSessionsByPosition();
		assert.deepEqual(order(context), ["a", "b"]);
		assert.deepEqual([...context.state.sessionPositions], positions);
		assert.equal(context.state.activeId, a.id);
	}
	assert.equal(context.getSessionRuntime(a).busy, true);
	assert.equal(context.getSessionRuntime(b).busy, true);
});

test("background solver tool calls do not change either list's positions", () => {
	const context = fixture();
	context.initializeSessionOrder([{ id: "main" }, { id: "solver-a" }, { id: "solver-b" }]);
	const main = context.upsertLocalSessionForBridgeSession({ id: "main" });
	context.state.activeId = main.id;
	for (const id of ["solver-a", "solver-b"]) context.rememberSolverSnapshot({ id, role: "solver" });
	const positions = [...context.state.sessionPositions];
	for (let index = 0; index < 30; index += 1) {
		context.handleNotification({ type: "session-state", role: "solver", sessionId: index % 2 ? "solver-a" : "solver-b",
			state: "running", event: "tool_execution_start", updatedAt: Date.now() / 1000 + index });
	}
	assert.deepEqual([...context.state.sessionPositions], positions);
	assert.equal(context.state.sessions.size, 1);
	assert.equal(context.state.solverSessions.size, 2);
	assert.equal(context.state.activeId, main.id);
});

test("dragged order survives refresh and a fresh page", async () => {
	const context = fixture();
	const a = context.upsertLocalSessionForBridgeSession({ id: "a" });
	const b = context.upsertLocalSessionForBridgeSession({ id: "b" });
	context.reorderSession(a.id, b.id);
	context.sortSessionsByPosition();
	assert.deepEqual(order(context), ["a", "b"]);
	context.bridgeApi.rpc = async () => ({ sessions: [{ id: "b", updatedAt: 9999 }, { id: "a" }] });
	await context.refreshPersistedSessions();
	assert.deepEqual(order(context), ["a", "b"]);
	const fresh = fixture();
	fresh.localStorage.setItem("secheur:session-order", context.localStorage.getItem("secheur:session-order"));
	fresh.initializeSessionOrder([{ id: "b" }, { id: "a" }]);
	fresh.upsertLocalSessionForBridgeSession({ id: "b" });
	fresh.upsertLocalSessionForBridgeSession({ id: "a" });
	assert.deepEqual(order(fresh), ["a", "b"]);
});

test("bootstrap preserves the bridge Main Agent preference over a stale saved conversation", async () => {
	const context = fixture();
	context.state.bridgeReady = false;
	context.sessionStorage.setItem("secheur:active-session", "saved");
	context.bridgeApi.rpc = async () => ({
		sessions: [{ id: "empty", title: "New chat" }, { id: "server" }, { id: "saved", msgSeq: 1 }],
		activeSessionId: "server",
	});
	await context.markBridgeReady();
	assert.equal(context.state.sessions.get(context.state.activeId).bridgeSessionId, "server");
	assert.equal(context.state.sessions.size, 3);
});

test("late bootstrap history cannot overwrite a newer selection", async () => {
	const context = fixture();
	const history = deferred();
	const started = deferred();
	context.state.bridgeReady = false;
	context.bridgeApi.rpc = async () => ({ sessions: [{ id: "a" }, { id: "b" }], activeSessionId: "b" });
	context.hydrateSessionMessages = () => { started.resolve(); return history.promise; };
	const bootstrap = context.markBridgeReady();
	await started.promise;
	const selected = context.findSessionByBridgeId("a");
	context.setActiveSession(selected.id);
	history.resolve();
	await bootstrap;
	assert.equal(context.state.activeId, selected.id);
});

test("late new-session response cannot steal selection", async () => {
	const context = fixture();
	const created = deferred();
	const existing = context.upsertLocalSessionForBridgeSession({ id: "existing" });
	context.bridgeApi.rpc = () => created.promise;
	const creating = context.newSession();
	await Promise.resolve();
	context.setActiveSession(existing.id);
	created.resolve({ sessionId: "new", session: { id: "new" } });
	await creating;
	assert.equal(context.state.activeId, existing.id);
	assert.ok(context.findSessionByBridgeId("new"));
});

test("late imported history cannot steal selection or resurrect a closed conversation", async () => {
	for (const closed of [false, true]) {
		const context = fixture();
		const history = deferred();
		const selected = context.upsertLocalSessionForBridgeSession({ id: "selected" });
		context.hydrateSessionMessages = () => history.promise;
		const opening = context.activateCommandSession({ id: "imported" });
		if (closed) context.state.sessions.delete(context.findSessionByBridgeId("imported").id);
		else context.setActiveSession(selected.id);
		history.resolve();
		await opening;
		assert.equal(context.state.activeId, closed ? null : selected.id);
	}
});

test("unavailable browser storage does not break session ordering", () => {
	const context = fixture();
	context.localStorage = {
		getItem() { throw new Error("storage disabled"); },
		setItem() { throw new Error("storage disabled"); },
	};
	context.initializeSessionOrder([{ id: "a" }, { id: "b" }]);
	context.upsertLocalSessionForBridgeSession({ id: "a" });
	context.upsertLocalSessionForBridgeSession({ id: "b" });
	assert.deepEqual(order(context), ["a", "b"]);
});

test("CTF Field uses the deployed API port and preserves an explicit override", () => {
	const context = fixture();
	context.location = { protocol: "http:", hostname: "100.85.231.58" };
	load(context, "defaultCtfFieldApiBase", "ctfFieldApiBase");
	assert.equal(context.ctfFieldApiBase(), "http://100.85.231.58:14230/api");
	context.localStorage.setItem("secheur:ctf-field-api-base", "https://field.example/api/");
	assert.equal(context.ctfFieldApiBase(), "https://field.example/api");
});

test("Markdown export preserves structured message content", () => {
	const context = fixture();
	load(context, "formatEventTime", "messageContentText", "formatSessionExportMarkdown");
	const markdown = context.formatSessionExportMarkdown({
		session: { id: "a", title: "Conversation" },
		messages: [{ role: "assistant", content: [{ type: "text", text: "Visible response" }] }],
	});
	assert.match(markdown, /Visible response/);
	assert.doesNotMatch(markdown, /\[object Object\]/);
});

test("CTF Field request has a timeout and surfaces API errors", async () => {
	const context = fixture();
	context.AbortSignal = AbortSignal;
	context.ctfFieldApiBase = () => "http://field.example/api";
	context.fetch = async (url, options) => {
		assert.equal(url, "http://field.example/api/record");
		assert.equal(options.method, "POST");
		assert.equal(options.headers["Content-Type"], "application/json");
		assert.ok(options.signal);
		return { ok: false, status: 503, json: async () => ({ error: "field unavailable" }) };
	};
	load(context, "ctfFieldApi");
	await assert.rejects(context.ctfFieldApi("/record", { method: "POST", body: "{}" }), /field unavailable/);
});

test("saving a conversation appends its trace and preserves the target result", async () => {
	const context = fixture();
	const session = context.upsertLocalSessionForBridgeSession({ id: "conversation" });
	const requests = [];
	context.promptCtfFieldTarget = async () => "cybench/example";
	context.ctfFieldApiBase = () => "http://field.example/api";
	context.addDiagnostic = () => {};
	context.showSystem = () => {};
	context.bridgeApi.rpc = async (method, args) => {
		assert.equal(method, "session/export");
		assert.equal(args.sessionId, "conversation");
		return { session: { id: "conversation" }, messages: [{ role: "assistant", content: "Visible trace" }] };
	};
	context.ctfFieldApi = async (path, options) => {
		requests.push(path);
		if (path.startsWith("/targets?")) return { targets: [{
			target_id: "cybench/example", status: "failed", process_note: "Existing note", failure_reason: "Existing reason",
		}] };
		const record = JSON.parse(options.body);
		assert.equal(record.target_id, "cybench/example");
		assert.equal(record.status, "failed");
		assert.equal(record.failure_reason, "Existing reason");
		assert.match(record.process_note, /Existing note/);
		assert.match(record.process_note, /Visible trace/);
		return { ok: true };
	};
	load(context, "formatEventTime", "messageContentText", "formatSessionExportMarkdown", "cleanTargetId",
		"extractTargetIdFromExport", "exportHasFinalAnswer", "inferCtfFieldStatus", "loadCtfFieldTarget",
		"formatCtfFieldProcessNote", "appendProcessNote", "saveSessionToCtfField");
	await context.saveSessionToCtfField(session.id);
	assert.equal(requests.length, 2);
	assert.equal(requests[1], "/record");
});

test("cancelling the CTF Field form never writes a record", async () => {
	const context = fixture();
	const session = context.upsertLocalSessionForBridgeSession({ id: "conversation" });
	context.bridgeApi.rpc = async () => ({ messages: [] });
	context.promptCtfFieldTarget = async () => "";
	context.ctfFieldApi = assert.fail;
	load(context, "messageContentText", "cleanTargetId", "extractTargetIdFromExport", "saveSessionToCtfField");
	await context.saveSessionToCtfField(session.id);
});
