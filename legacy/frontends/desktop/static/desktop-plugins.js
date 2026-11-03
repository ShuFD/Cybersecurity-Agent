(() => {
  'use strict';

  const records = new Map();
  let loadingPluginId = '';
  let observer = null;
  let decorateFrame = 0;
  let refreshSerial = 0;
  let refreshTail = Promise.resolve();

  function messagesRoot() {
    return document.getElementById('messages');
  }

  function report(plugin, phase, error) {
    const name = plugin?.name || plugin?.id || 'unknown';
    console.error(`[Desktop UI plugin] ${name} ${phase}`, error);
  }

  function contextFor(record) {
    return Object.freeze({
      id: record.plugin.id,
      plugin: record.plugin,
      root: messagesRoot(),
      scheduleDecorate,
    });
  }

  function runDecorators() {
    decorateFrame = 0;
    const root = messagesRoot();
    if (!root) return;
    for (const record of records.values()) {
      for (const entry of record.definitions) {
        if (!entry.active) continue;
        if (typeof entry.definition.decorate !== 'function') continue;
        try {
          entry.definition.decorate(root, contextFor(record));
        } catch (error) {
          report(record.plugin, 'decorate failed:', error);
        }
      }
    }
  }

  function scheduleDecorate() {
    if (decorateFrame) return;
    decorateFrame = window.requestAnimationFrame(runDecorators);
  }

  function register(definition) {
    const scriptPluginId = document.currentScript?.dataset?.desktopPluginId || '';
    const pluginId = scriptPluginId || loadingPluginId;
    const record = records.get(pluginId);
    if (!record || !definition || typeof definition !== 'object') {
      throw new Error('Desktop UI plugins must register synchronously from a declared plugin script');
    }
    record.definitions.push({ definition, cleanup: null, active: false });
    if (!record.loading) activateDefinition(record, record.definitions.at(-1));
    scheduleDecorate();
  }

  function activateDefinition(record, entry) {
    if (!entry || entry.active) return;
    try {
      if (typeof entry.definition.setup === 'function') {
        const cleanup = entry.definition.setup(contextFor(record));
        if (typeof cleanup === 'function') entry.cleanup = cleanup;
      }
      entry.active = true;
    } catch (error) {
      report(record.plugin, 'setup failed:', error);
    }
  }

  function appendStylesheet(record, url, serial) {
    return new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${url}?desktop-plugin-revision=${serial}`;
      link.dataset.desktopPluginId = record.plugin.id;
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', () => reject(new Error(`Could not load stylesheet: ${url}`)), { once: true });
      record.elements.push(link);
      document.head.appendChild(link);
    });
  }

  function appendScript(record, url, serial) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${url}?desktop-plugin-revision=${serial}`;
      script.async = false;
      script.dataset.desktopPluginId = record.plugin.id;
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error(`Could not load script: ${url}`)), { once: true });
      record.elements.push(script);
      loadingPluginId = record.plugin.id;
      document.head.appendChild(script);
    }).finally(() => {
      if (loadingPluginId === record.plugin.id) loadingPluginId = '';
    });
  }

  async function loadPlugin(plugin, serial) {
    const record = {
      plugin,
      signature: JSON.stringify(plugin),
      loading: true,
      definitions: [],
      elements: [],
    };
    records.set(plugin.id, record);
    try {
      for (const url of plugin.styles || []) await appendStylesheet(record, url, serial);
      for (const url of plugin.scripts || []) await appendScript(record, url, serial);
      record.loading = false;
      for (const entry of record.definitions) activateDefinition(record, entry);
    } catch (error) {
      report(plugin, 'load failed:', error);
      unloadPlugin(plugin.id);
    }
  }

  function unloadPlugin(pluginId) {
    const record = records.get(pluginId);
    if (!record) return;
    for (const entry of [...record.definitions].reverse()) {
      if (!entry.active) continue;
      try {
        entry.cleanup?.();
      } catch (error) {
        report(record.plugin, 'cleanup failed:', error);
      }
      try {
        entry.definition.destroy?.(contextFor(record));
      } catch (error) {
        report(record.plugin, 'destroy failed:', error);
      }
    }
    for (const element of [...record.elements].reverse()) element.remove();
    records.delete(pluginId);
  }

  function validPlugin(plugin) {
    return !!plugin
      && typeof plugin.id === 'string'
      && /^[a-f0-9]{24}$/.test(plugin.id)
      && Array.isArray(plugin.styles)
      && Array.isArray(plugin.scripts)
      && plugin.styles.every((url) => typeof url === 'string' && url.startsWith('/plugins/ui-assets/'))
      && plugin.scripts.every((url) => typeof url === 'string' && url.startsWith('/plugins/ui-assets/'));
  }

  async function performRefresh(force) {
    const response = await fetch('/plugins/ui', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Desktop UI plugin list returned ${response.status}`);
    const payload = await response.json();
    if (payload?.ok === false) throw new Error(payload.error || 'Desktop UI plugin list failed');
    const plugins = (Array.isArray(payload?.plugins) ? payload.plugins : []).filter(validPlugin);
    const desired = new Map(plugins.map((plugin) => [plugin.id, plugin]));

    for (const [pluginId, record] of [...records]) {
      const plugin = desired.get(pluginId);
      if (force || !plugin || record.signature !== JSON.stringify(plugin)) unloadPlugin(pluginId);
    }

    const serial = ++refreshSerial;
    for (const plugin of plugins) {
      if (!records.has(plugin.id)) await loadPlugin(plugin, serial);
    }
    scheduleDecorate();
    return payload;
  }

  function refresh(options = {}) {
    const force = options?.force === true;
    const task = () => performRefresh(force);
    refreshTail = refreshTail.then(task, task);
    return refreshTail;
  }

  function start() {
    const root = messagesRoot();
    if (root && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(scheduleDecorate);
      observer.observe(root, { childList: true, subtree: true, characterData: true });
    }
    refresh().catch((error) => report(null, 'initial load failed:', error));
  }

  const api = Object.freeze({ register, refresh });
  Object.defineProperty(window, 'SecHeurDesktopPlugins', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: api,
  });

  window.addEventListener('beforeunload', () => {
    observer?.disconnect();
    if (decorateFrame) window.cancelAnimationFrame(decorateFrame);
    for (const pluginId of [...records.keys()]) unloadPlugin(pluginId);
  }, { once: true });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
