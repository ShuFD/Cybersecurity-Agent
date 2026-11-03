// SecHeur Agent browser bridge adapter.
// HTTP is the command/data channel. WebSocket only carries small state events.
(() => {
  'use strict';

  const listeners = new Map();
  let ws = null;
  let cachedBridgeReady = null;
  const bridgeProtocol = location.protocol === 'https:' ? 'https:' : 'http:';
  const bridgeHost = location.hostname || '127.0.0.1';
  const bridgePort = location.port || '14168';
  const bridgeBase = `${bridgeProtocol}//${bridgeHost}:${bridgePort}`;
  const wsUrl = `${bridgeProtocol === 'https:' ? 'wss' : 'ws'}://${bridgeHost}:${bridgePort}/ws`;

  function on(channel, cb) {
    if (typeof cb !== 'function') return () => {};
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(cb);
    if (channel === 'bridge-ready' && cachedBridgeReady) {
      try { cb(cachedBridgeReady); } catch (err) { console.error('[secheur-web listener] replay bridge-ready', err); }
    }
    return () => listeners.get(channel)?.delete(cb);
  }

  function emit(channel, payload) {
    if (channel === 'bridge-ready') cachedBridgeReady = payload;
    const set = listeners.get(channel);
    if (!set) return;
    for (const cb of Array.from(set)) {
      try { cb(payload); } catch (err) { console.error('[secheur-web listener]', channel, err); }
    }
  }

  async function http(path, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    const init = Object.assign({}, options, { headers });
    if (init.body && typeof init.body !== 'string') {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      init.body = JSON.stringify(init.body);
    }
    const res = await fetch(`${bridgeBase}${path}`, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.message)) || `${res.status} ${res.statusText}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function connectWs() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try {
      ws = new WebSocket(wsUrl);
      ws.addEventListener('open', () => emit('bridge-log', 'WS state channel connected'));
      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg.type === 'bridge-ready') {
          emit('bridge-ready', msg);
        } else if (msg.type === 'session-state') {
          emit('bridge-notification', msg);
        } else if (msg.type === 'worklist-state') {
          emit('bridge-notification', msg);
        } else if (msg.type === 'bridge-log') {
          emit('bridge-log', msg.payload || msg);
        } else if (msg.type === 'bridge-error') {
          emit('bridge-error', msg.payload || msg);
        }
      });
      ws.addEventListener('close', () => emit('bridge-closed', { reason: 'ws-closed' }));
      ws.addEventListener('error', () => emit('bridge-error', { type: 'ws-error', message: 'WebSocket state channel error' }));
    } catch (err) {
      emit('bridge-error', { type: 'ws-error', message: err.message || String(err) });
    }
  }

  async function rpc(method, params = {}) {
    switch (method) {
      case 'planning/options/get':
        return http('/planning/options');
      case 'planning/graph/get':
        return http(`/session/${encodeURIComponent(params.sessionId)}/planning/graph${params.node ? `?node=${encodeURIComponent(params.node)}` : ''}`);
      case 'planning/options/save':
        return http('/planning/options', { method: 'POST', body: params });
      case 'app/status':
        return http('/status');
      case 'app/config/get':
        return http('/config');
      case 'app/config/save':
        return http('/config', { method: 'POST', body: params || {} });
      case 'app/api-config/get':
        return http('/api-config');
      case 'app/api-config/save':
        return http('/api-config', { method: 'POST', body: params || {} });
      case 'app/api-config/models':
        return http('/api-config/models', { method: 'POST', body: params || {} });
      case 'app/api-config/test':
        return http('/api-config/test', { method: 'POST', body: params || {} });
      case 'app/api-config/delete':
        if (!params.name) throw new Error('app/api-config/delete missing name');
        return http(`/api-config/${encodeURIComponent(params.name)}`, { method: 'DELETE' });
      case 'app/mcp-config/save':
        return http('/mcp-config', { method: 'POST', body: params || {} });
      case 'app/skill-config/save':
        return http('/skill-config', { method: 'POST', body: params || {} });
      case 'app/agent-config/save':
        return http('/agent-config', { method: 'POST', body: params || {} });
      case 'app/mcp-config/delete':
        if (!params.name) throw new Error('app/mcp-config/delete missing name');
        return http(`/mcp-config/${encodeURIComponent(params.name)}`, { method: 'DELETE' });
      case 'app/skill-config/delete':
        if (!params.name) throw new Error('app/skill-config/delete missing name');
        return http(`/skill-config/${encodeURIComponent(params.name)}`, { method: 'DELETE' });
      case 'app/agent-config/delete':
        if (!params.name) throw new Error('app/agent-config/delete missing name');
        return http(`/agent-config/${encodeURIComponent(params.name)}`, { method: 'DELETE' });
      case 'app/registry/list':
        return http('/registry');
      case 'app/registry/save':
        return http('/registry', { method: 'POST', body: params || {} });
      case 'app/plugins/list':
        return http('/plugins');
      case 'app/plugins/catalog':
        return http('/plugins/catalog');
      case 'app/plugins/catalog/toggle':
        return http('/plugins/catalog/toggle', { method: 'POST', body: params || {} });
      case 'app/plugins/install':
        return http('/plugins/install', { method: 'POST', body: params || {} });
      case 'app/plugins/toggle':
        return http('/plugins/toggle', { method: 'POST', body: params || {} });
      case 'app/plugins/update':
        return http('/plugins/update', { method: 'POST', body: params || {} });
      case 'app/plugins/remove':
        return http('/plugins/remove', { method: 'POST', body: params || {} });
      case 'get/model-profiles':
        return http('/model-profiles');
      case 'session/list': {
        const query = params.includeSolvers === false ? '?includeSolvers=false' : '';
        return http(`/sessions${query}`);
      }
      case 'session/new':
        return http('/session/new', { method: 'POST', body: params || {} });
      case 'session/get': {
        const sid = params.sessionId || params.id || params.bridgeSessionId;
        if (!sid) throw new Error('session/get missing sessionId');
        return http(`/session/${encodeURIComponent(sid)}`);
      }
      case 'session/delete': {
        const sid = params.sessionId || params.id || params.bridgeSessionId;
        if (!sid) throw new Error('session/delete missing sessionId');
        return http(`/session/${encodeURIComponent(sid)}`, { method: 'DELETE' });
      }
      case 'session/activate': {
        const sid = params.sessionId || params.id || params.bridgeSessionId;
        if (!sid) throw new Error('session/activate missing sessionId');
        return http(`/session/${encodeURIComponent(sid)}/activate`, { method: 'POST', body: params || {} });
      }
      case 'session/prompt': {
        const sid = params.sessionId || params.id || params.bridgeSessionId;
        if (!sid) throw new Error('session/prompt missing sessionId');
        return http(`/session/${encodeURIComponent(sid)}/prompt`, { method: 'POST', body: params || {} });
      }
      case 'session/poll': {
        const sid = params.sessionId || params.id || params.bridgeSessionId;
        if (!sid) throw new Error('session/poll missing sessionId');
        const after = params.afterId ?? params.after ?? 0;
        const limit = params.limit ?? 200;
        return http(`/session/${encodeURIComponent(sid)}/messages?after=${encodeURIComponent(after)}&limit=${encodeURIComponent(limit)}`);
      }
      case 'session/commands': {
        const sid = params.sessionId || params.id || params.bridgeSessionId;
        if (!sid) throw new Error('session/commands missing sessionId');
        return http(`/session/${encodeURIComponent(sid)}/commands`);
      }
      case 'session/command': {
        const sid = params.sessionId || params.id || params.bridgeSessionId;
        if (!sid) throw new Error('session/command missing sessionId');
        if (!params.command && !params.name) throw new Error('session/command missing command');
        return http(`/session/${encodeURIComponent(sid)}/command`, { method: 'POST', body: params || {} });
      }
      case 'session/cancel': {
        const sid = params.sessionId || params.id || params.bridgeSessionId;
        if (!sid) throw new Error('session/cancel missing sessionId');
        return http(`/session/${encodeURIComponent(sid)}/cancel`, { method: 'POST', body: params || {} });
      }
      case 'session/permission': {
        const sid = params.sessionId || params.id || params.bridgeSessionId;
        const rid = params.requestId || params.request_id;
        if (!sid) throw new Error('session/permission missing sessionId');
        if (!rid) throw new Error('session/permission missing requestId');
        return http(`/session/${encodeURIComponent(sid)}/permission/${encodeURIComponent(rid)}`, { method: 'POST', body: params || {} });
      }
      case 'session/model': {
        const sid = params.sessionId || params.id || params.bridgeSessionId;
        if (!sid) throw new Error('session/model missing sessionId');
        return http(`/session/${encodeURIComponent(sid)}/model`, { method: 'POST', body: params || {} });
      }
      case 'session/runtime/reset': {
        const sid = params.sessionId || params.id || params.bridgeSessionId;
        if (!sid) throw new Error('session/runtime/reset missing sessionId');
        return http(`/session/${encodeURIComponent(sid)}/runtime/reset`, { method: 'POST', body: params || {} });
      }
      case 'session/runtime/log': {
        const sid = params.sessionId || params.id || params.bridgeSessionId;
        if (!sid) throw new Error('session/runtime/log missing sessionId');
        const query = new URLSearchParams();
        // 保留游标参数，轨迹查看器可按增量读取，避免反复加载完整记录。
        for (const name of ['afterEventId', 'afterMessageId', 'logEpoch']) {
          if (params[name] !== undefined && params[name] !== null && params[name] !== '') {
            query.set(name, String(params[name]));
          }
        }
        for (const name of ['includeMessages', 'incremental']) {
          if (params[name] !== undefined && params[name] !== null) {
            query.set(name, params[name] === true ? 'true' : params[name] === false ? 'false' : String(params[name]));
          }
        }
        const suffix = query.toString() ? `?${query.toString()}` : '';
        return http(`/session/${encodeURIComponent(sid)}/runtime/log${suffix}`);
      }
      case 'session/export': {
        const sid = params.sessionId || params.id || params.bridgeSessionId;
        if (!sid) throw new Error('session/export missing sessionId');
        return http(`/session/${encodeURIComponent(sid)}/export`);
      }
      case 'worklist/get':
        return http('/worklist');
      case 'worklist/start':
        return http('/worklist/start', { method: 'POST', body: params || {} });
      case 'worklist/stop': {
        const itemId = params.itemId || params.id;
        if (!itemId) return http('/worklist/stop', { method: 'POST', body: params || {} });
        return http(`/worklist/${encodeURIComponent(itemId)}/stop`, { method: 'POST', body: params || {} });
      }
      case 'worklist/sync':
        return http('/worklist/sync', { method: 'POST', body: params || {} });
      case 'worklist/retry': {
        const itemId = params.itemId || params.id;
        if (!itemId) throw new Error('worklist/retry missing itemId');
        return http(`/worklist/${encodeURIComponent(itemId)}/retry`, { method: 'POST', body: params || {} });
      }
      case 'worklist/guide': {
        const itemId = params.itemId || params.id;
        if (!itemId) throw new Error('worklist/guide missing itemId');
        if (!params.message && !params.prompt) throw new Error('worklist/guide missing message');
        return http(`/worklist/${encodeURIComponent(itemId)}/guide`, { method: 'POST', body: params || {} });
      }
      case 'session/permission-mode': {
        const sid = params.sessionId || params.id || params.bridgeSessionId;
        if (!sid) throw new Error('session/permission-mode missing sessionId');
        return http(`/session/${encodeURIComponent(sid)}/permission-mode`, { method: 'POST', body: params || {} });
      }
      case 'app/path/open':
        return http('/path/open', { method: 'POST', body: params || {} });
      case 'app/path/selectProjectRoot':
        return http('/config');
      case 'list_continuable_sessions': {
        const query = params.includeSolvers === false ? '?includeSolvers=false' : '';
        return http(`/sessions/continuable${query}`);
      }
      case 'restore_session': {
        const sid = params.sessionId || params.session_id || params.id || params.bridgeSessionId;
        if (!sid) throw new Error('restore_session missing sessionId');
        return http(`/session/${encodeURIComponent(sid)}/restore`, { method: 'POST', body: params || {} });
      }
      default:
        throw new Error(`Unknown RPC method: ${method}`);
    }
  }

  const secheurAgent = {
    platform: navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'win32',
    startBridge: async () => { connectWs(); return http('/status'); },
    stopBridge: async () => ({ ok: true }),
    checkStatus: () => rpc('app/status', {}),
    getConfig: () => rpc('app/config/get', {}),
    saveConfig: (cfg) => rpc('app/config/save', cfg || {}),
    getApiConfig: () => rpc('app/api-config/get', {}),
    saveApiConfig: (cfg) => rpc('app/api-config/save', { config: cfg || {} }),
    fetchApiModels: (cfg) => rpc('app/api-config/models', { config: cfg || {} }),
    testApiResponse: (cfg) => rpc('app/api-config/test', { config: cfg || {} }),
    deleteApiConfig: (name) => rpc('app/api-config/delete', { name }),
    saveMcpConfig: (cfg) => rpc('app/mcp-config/save', { config: cfg || {} }),
    saveSkillConfig: (cfg) => rpc('app/skill-config/save', { config: cfg || {} }),
    saveAgentConfig: (cfg) => rpc('app/agent-config/save', { config: cfg || {} }),
    deleteMcpConfig: (name) => rpc('app/mcp-config/delete', { name }),
    deleteSkillConfig: (name) => rpc('app/skill-config/delete', { name }),
    deleteAgentConfig: (name) => rpc('app/agent-config/delete', { name }),
    listRegistry: () => rpc('app/registry/list', {}),
    saveRegistry: (updates) => rpc('app/registry/save', updates || {}),
    listPlugins: () => rpc('app/plugins/list', {}),
    listPluginCatalog: () => rpc('app/plugins/catalog', {}),
    setCatalogPluginEnabled: (plugin, enabled) => rpc('app/plugins/catalog/toggle', {
      key: plugin?.key,
      id: plugin?.id,
      kind: plugin?.kind,
      source: plugin?.source,
      scope: plugin?.scope,
      enabled,
    }),
    installPlugin: (source, scope) => rpc('app/plugins/install', { source, scope }),
    setPluginEnabled: (source, scope, enabled) => rpc('app/plugins/toggle', { source, scope, enabled }),
    updatePlugin: (source, scope) => rpc('app/plugins/update', { source, scope }),
    removePlugin: (source, scope) => rpc('app/plugins/remove', { source, scope }),
    getModelProfiles: () => rpc('get/model-profiles', {}),
    selectProjectRoot: () => rpc('app/path/selectProjectRoot', {}),
    openMykeyTemplate: () => rpc('app/path/open', { kind: 'mykeyTemplate' }),
    pollSession: (sessionId, afterId = 0) => rpc('session/poll', { sessionId, afterId }),
    getWorklist: () => rpc('worklist/get', {}),
    startWorklist: () => rpc('worklist/start', {}),
    stopWorklist: () => rpc('worklist/stop', {}),
    syncWorklist: () => rpc('worklist/sync', {}),
    retryWorklist: (itemId) => rpc('worklist/retry', { itemId }),
    guideWorklist: (itemId, message) => rpc('worklist/guide', { itemId, message }),
    stopWorklistItem: (itemId) => rpc('worklist/stop', { itemId }),
    rpc,
    onBridgeMessage: (cb) => on('bridge-message', cb),
    onBridgeNotification: (cb) => on('bridge-notification', cb),
    onBridgeError: (cb) => on('bridge-error', cb),
    onBridgeClosed: (cb) => on('bridge-closed', cb),
    onBridgeReady: (cb) => on('bridge-ready', cb),
    onBridgeLog: (cb) => on('bridge-log', cb),
    onOpenSearch: (cb) => on('open-search', cb)
  };
  window.secheurAgent = secheurAgent;

  connectWs();
  http('/status').then(status => emit('bridge-ready', status)).catch(err => emit('bridge-error', { type: 'http-error', message: err.message || String(err) }));
})();
