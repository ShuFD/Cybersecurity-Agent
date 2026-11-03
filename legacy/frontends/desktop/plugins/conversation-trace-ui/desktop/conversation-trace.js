(() => {
  'use strict';

  const host = window.SecHeurDesktopPlugins;
  if (!host) return;

  const decoratedTurns = new Set();
  const decoratedMessages = new Set();
  const decoratedInlineThinking = new Set();
  const originalHeader = Symbol('conversationTraceOriginalHeader');
  const originalInlineThinking = Symbol('conversationTraceOriginalInlineThinking');

  const icons = {
    think: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 4.5A3 3 0 0 0 5 7a3 3 0 0 0 .5 5.5A3 3 0 0 0 9 17.4V20"/><path d="M14.5 4.5A3 3 0 0 1 19 7a3 3 0 0 1-.5 5.5 3 3 0 0 1-3.5 4.9V20"/><path d="M9.5 4.5A3 3 0 0 1 12 3a3 3 0 0 1 2.5 1.5M9 9h6M9 14h6M12 3v17"/></svg>',
    bash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="14" x="3" y="5" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/></svg>',
    read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5z"/><polyline points="14 2 14 8 20 8"/><path d="M8 13h8M8 17h6"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>',
    browser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    mcp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="8.5" y="14" width="7" height="7" rx="1"/><path d="M6.5 10v2h11v-2M12 12v2"/></svg>',
    agent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="7" width="16" height="13" rx="2"/><path d="M9 12h.01M15 12h.01M9 16h6M12 7V3M9 3h6"/></svg>',
    tool: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 9.6 6 7.3 3.7a4 4 0 0 0 5 5l-8.6 8.6a2.1 2.1 0 0 0 3 3l8.6-8.6a4 4 0 0 0 5-5L18 9l-2.4-2.4 2.3-2.3a4 4 0 0 0-3.2 2z"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  };

  function compact(value, limit = 320) {
    const text = String(value || '')
      .replace(/<\/?(?:summary|think|function_calls|function_results)[^>]*>/gi, ' ')
      .replace(/<\/?(?:invoke|parameter|result)[^>]*>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  }

  function firstLine(value) {
    const line = String(value || '')
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find(Boolean);
    return compact(line || value);
  }

  function rawTurnText(turn) {
    return String(turn.dataset.buf || turn.querySelector(':scope > .turn-body')?.textContent || '');
  }

  function toolName(turn, raw) {
    if (turn.dataset.toolName) return turn.dataset.toolName;
    const nested = turn.querySelector('.tool-detail-header .turn-tag')?.textContent || '';
    const match = `${raw}\n${nested}`.match(/(?:Tool:\s*|<invoke\b[^>]*\bname=["'])([\w.:-]+)/i);
    return match?.[1] || '';
  }

  function classifyTurn(turn) {
    const kind = String(turn.dataset.kind || '');
    const raw = rawTurnText(turn);
    const tool = toolName(turn, raw);
    const source = `${kind} ${tool} ${raw}`;
    if (/LLM_RUNNING|agent_thought_chunk|\bthinking\b|\bthought\b/i.test(source)) {
      return { key: 'think', label: 'Think', fallback: '分析问题并规划下一步' };
    }
    if (/SUB_AGENT|TEMP_SUB_AGENT|sub.?agent|agent_task/i.test(source)) {
      return { key: 'agent', label: 'Agent', fallback: '调用子 Agent' };
    }
    if (/\bmcp\b/i.test(source)) return { key: 'mcp', label: 'MCP', fallback: '调用外部工具' };
    if (/web_fetch|web_search|browser|fetch_url|navigate|http_request/i.test(source)) {
      return { key: 'browser', label: 'Browser', fallback: '访问网页' };
    }
    if (/file_read|read_file|file_fetch|list_files|directory_list/i.test(source)) {
      return { key: 'read', label: 'Read', fallback: '读取文件' };
    }
    if (/grep_search|file_search|\bsearch\b|find_text/i.test(source)) {
      return { key: 'search', label: 'Search', fallback: '搜索内容' };
    }
    if (/code_run|run_command|\bbash\b|\bshell\b|terminal|\bpython\b|\bnode\b|\bexec\b/i.test(source)) {
      return { key: 'bash', label: 'Bash', fallback: '执行命令' };
    }
    return { key: 'tool', label: 'Tool', fallback: '运行工具' };
  }

  function isProseTurn(turn) {
    return /^(?:agent_message_chunk|assistant_message|response)$/i.test(String(turn.dataset.kind || ''));
  }

  function quotedField(raw, fields) {
    for (const field of fields) {
      const pattern = new RegExp(`["']${field}["']\\s*[:=]\\s*["']((?:\\\\.|[^"'])*)["']`, 'i');
      const match = String(raw || '').match(pattern);
      if (!match) continue;
      return match[1]
        .replace(/\\n/g, ' ')
        .replace(/\\t/g, ' ')
        .replace(/\\([\\"'])/g, '$1');
    }
    return '';
  }

  function descriptionFor(turn, meta) {
    const raw = rawTurnText(turn);
    const toolStatus = String(turn.dataset.toolStatus || '');
    if (toolStatus === 'error') {
      const errorText = turn.querySelector('.conversation-tool-error .conversation-tool-section-content')?.textContent || '';
      if (errorText) return firstLine(errorText);
    }
    const taggedSummary = raw.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] || '';
    if (taggedSummary) return firstLine(taggedSummary);
    const fieldOrder = meta.key === 'bash'
      ? ['command', 'cmd', 'code']
      : meta.key === 'browser'
        ? ['url', 'query']
        : ['path', 'query', 'pattern', 'name'];
    const fieldValue = quotedField(raw, fieldOrder);
    if (fieldValue) return compact(fieldValue);
    const narrative = turn.querySelector(':scope > .turn-narrative')?.textContent || '';
    if (narrative) return firstLine(narrative);
    const header = turn.querySelector(':scope > .turn-header');
    const summary = header?.querySelector('.turn-summary')?.textContent || '';
    const previousPluginSummary = header?.dataset.traceSummary || '';
    if (summary && summary !== previousPluginSummary && !/^正在|^准备|^工具|^步骤/u.test(summary)) {
      return compact(summary);
    }
    if (meta.key === 'think') {
      const taggedThink = raw.match(/<think\b[^>]*>([\s\S]*?)<\/think>/i)?.[1] || '';
      if (taggedThink) return firstLine(taggedThink);
      const body = turn.querySelector(':scope > .turn-body')?.textContent || '';
      const bodySummary = firstLine(body);
      if (bodySummary) return bodySummary;
    }
    const name = toolName(turn, raw);
    return name && name.toLowerCase() !== meta.label.toLowerCase() ? compact(name) : meta.fallback;
  }

  function isNestedTurn(turn) {
    return !!turn.parentElement?.closest('.turn');
  }

  function decorateInlineThink(think) {
    const summarySource = think.previousElementSibling?.classList.contains('summary-hint')
      ? think.previousElementSibling
      : null;
    const bodyText = think[originalInlineThinking]?.bodyText || think.textContent || '';
    const summaryText = firstLine(summarySource?.textContent || bodyText) || '分析问题并规划下一步';
    if (!think[originalInlineThinking]) {
      think[originalInlineThinking] = {
        html: think.innerHTML,
        bodyText,
        summarySource,
      };
      think.innerHTML = `
        <button class="trace-inline-think-header" type="button" aria-expanded="false">
          <span class="trace-turn-leading">
            <span class="trace-turn-icon">${icons.think}</span>
            <span class="trace-turn-chevron">${icons.chevron}</span>
          </span>
          <span class="turn-tag">Think</span>
          <span class="trace-turn-separator" aria-hidden="true"></span>
          <span class="turn-summary"></span>
        </button>
        <div class="trace-inline-think-body" hidden></div>`;
      const header = think.querySelector('.trace-inline-think-header');
      header?.addEventListener('click', () => {
        const expanded = think.classList.toggle('expanded');
        header.setAttribute('aria-expanded', String(expanded));
        const body = think.querySelector('.trace-inline-think-body');
        if (body) body.hidden = !expanded;
      });
    }
    think.classList.add('trace-inline-think');
    summarySource?.classList.add('trace-inline-think-summary-source');
    const summary = think.querySelector('.turn-summary');
    if (summary && summary.textContent !== summaryText) summary.textContent = summaryText;
    const body = think.querySelector('.trace-inline-think-body');
    if (body && body.textContent !== bodyText) body.textContent = bodyText;
    const header = think.querySelector('.trace-inline-think-header');
    header?.setAttribute('aria-label', `Think：${summaryText}`);
    decoratedInlineThinking.add(think);
  }

  function decorateProseTurn(turn) {
    const header = turn.querySelector(':scope > .turn-header');
    if (header && turn[originalHeader]) header.innerHTML = turn[originalHeader];
    header?.classList.remove('trace-turn-header');
    header?.removeAttribute('aria-label');
    turn.classList.remove('trace-turn', 'trace-turn-busy');
    turn.classList.add('trace-prose-turn');
    delete turn.dataset.traceType;
    delete turn[originalHeader];
    decoratedTurns.add(turn);
  }

  function decorateTurn(turn) {
    if (isProseTurn(turn)) {
      decorateProseTurn(turn);
      return;
    }
    const header = turn.querySelector(':scope > .turn-header');
    if (!header) return;
    const meta = classifyTurn(turn);
    const description = descriptionFor(turn, meta);
    if (!turn[originalHeader]) turn[originalHeader] = header.innerHTML;
    const hasDecoration = !!header.querySelector(':scope > .trace-turn-leading');
    const hasBusyIndicator = !!header.querySelector('.turn-status-dot.busy') || turn.classList.contains('trace-turn-busy');
    if (!hasDecoration) {
      header.innerHTML = `
        <span class="trace-turn-leading">
          <span class="trace-turn-icon">${icons[meta.key] || icons.tool}</span>
          <span class="trace-turn-chevron">${icons.chevron}</span>
        </span>
        <span class="turn-tag">${meta.label}</span>
        <span class="trace-turn-separator" aria-hidden="true"></span>
        <span class="turn-summary"></span>`;
    }
    turn.classList.remove('trace-prose-turn');
    turn.classList.add('trace-turn');
    const toolStatus = String(turn.dataset.toolStatus || '');
    turn.classList.toggle('trace-turn-busy', toolStatus === 'running' || hasBusyIndicator);
    turn.classList.toggle('trace-turn-error', toolStatus === 'error');
    turn.classList.toggle('trace-turn-stopped', toolStatus === 'stopped');
    header.classList.add('trace-turn-header');
    if (turn.dataset.traceType !== meta.key) {
      turn.dataset.traceType = meta.key;
      const icon = header.querySelector('.trace-turn-icon');
      if (icon) icon.innerHTML = icons[meta.key] || icons.tool;
    }
    const tag = header.querySelector('.turn-tag');
    if (tag && tag.textContent !== meta.label) tag.textContent = meta.label;
    const summary = header.querySelector('.turn-summary');
    if (summary && summary.textContent !== description) summary.textContent = description;
    header.dataset.traceSummary = description;
    const statusLabel = toolStatus === 'running'
      ? '，正在运行'
      : toolStatus === 'error'
        ? '，运行失败'
        : toolStatus === 'stopped'
          ? '，已停止'
          : '';
    const accessibleLabel = `${meta.label}：${description}${statusLabel}`;
    if (header.getAttribute('aria-label') !== accessibleLabel) header.setAttribute('aria-label', accessibleLabel);
    decoratedTurns.add(turn);
  }

  function decorateMessage(message) {
    message.classList.add('trace-message');
    decoratedMessages.add(message);
    message.querySelectorAll(':scope > .assistant-response').forEach((response) => {
      response.classList.add('trace-prose-flow');
    });
    message.querySelectorAll('.assistant-response .think-hint').forEach((think) => {
      if (!think.closest('.turn')) decorateInlineThink(think);
    });
    const turns = [...message.querySelectorAll('.turn')].filter((turn) => !isNestedTurn(turn));
    for (const turn of turns) decorateTurn(turn);
  }

  function restore() {
    for (const turn of decoratedTurns) {
      const header = turn.querySelector(':scope > .turn-header');
      if (header && turn[originalHeader]) header.innerHTML = turn[originalHeader];
      header?.classList.remove('trace-turn-header');
      header?.removeAttribute('aria-label');
      if (header) delete header.dataset.traceSummary;
      turn.classList.remove('trace-turn', 'trace-turn-busy', 'trace-turn-error', 'trace-turn-stopped', 'trace-prose-turn');
      delete turn.dataset.traceType;
      delete turn[originalHeader];
    }
    for (const think of decoratedInlineThinking) {
      const original = think[originalInlineThinking];
      original?.summarySource?.classList.remove('trace-inline-think-summary-source');
      if (original) think.innerHTML = original.html;
      think.classList.remove('trace-inline-think', 'expanded');
      delete think[originalInlineThinking];
    }
    for (const message of decoratedMessages) {
      message.classList.remove('trace-message');
      message.querySelectorAll('.trace-prose-flow').forEach((response) => {
        response.classList.remove('trace-prose-flow');
      });
    }
    decoratedTurns.clear();
    decoratedInlineThinking.clear();
    decoratedMessages.clear();
  }

  host.register({
    setup() {
      document.documentElement.classList.add('conversation-trace-ui');
      return () => document.documentElement.classList.remove('conversation-trace-ui');
    },
    decorate(root) {
      root.querySelectorAll('.msg-assistant').forEach(decorateMessage);
    },
    destroy: restore,
  });
})();
