import unittest
import shutil
import subprocess
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def js_function_source(source, name):
    start = source.index(f"function {name}(")
    params_start = source.index("(", start)
    depth = 0
    params_end = None
    for index in range(params_start, len(source)):
        char = source[index]
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                params_end = index
                break
    if params_end is None:
        raise AssertionError(f"Could not locate parameters for JS function {name}")
    brace = source.index("{", params_end)
    depth = 0
    for index in range(brace, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start : index + 1]
    raise AssertionError(f"Could not extract JS function {name}")


class DesktopStaticUiTests(unittest.TestCase):
    def test_attempt_dedup_setting_is_exposed_and_disabled_by_default(self):
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn('id="cfg-attempt-dedup" type="checkbox"', index_html)
        self.assertIn("启用状态感知的重复尝试防护", index_html)
        self.assertIn("attemptDedupEnabled: false", app_js)
        self.assertIn("{ id: 'cfg-attempt-dedup', key: 'attemptDedupEnabled', enabledByDefault: false }", app_js)

    def test_desktop_html_declares_chinese_language(self):
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        self.assertIn('<html lang="zh-CN" data-theme="white">', index_html)
        self.assertNotIn('<html lang="en">', index_html)

    def test_panel_mode_entrypoints_are_removed(self):
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertNotIn("panel-mode-btn", index_html)
        self.assertNotIn("data-workbench-view", index_html)
        self.assertNotIn('data-workbench-view="panel"', index_html)
        self.assertNotIn('id="panel-view"', index_html)
        self.assertNotIn("data-panel-action", index_html)
        self.assertNotIn("{ name: 'panel'", app_js)
        self.assertNotIn("runPanelAction", app_js)
        self.assertNotIn("activeWorkbenchView", app_js)
        self.assertNotIn("setWorkbenchView", app_js)
        self.assertNotIn("chatModeBtn", app_js)
        self.assertNotIn(".panel-view", styles)

    def test_workspace_and_message_search_entrypoints_are_removed(self):
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        for token in (
            "sidebar-search-btn",
            'id="search-bar"',
            'id="search-input"',
            "workspace-add-btn",
            "workspace-row",
            "add-project-btn",
            "settings-change-cwd",
            "cfg-workspace-groups",
            "工作区",
            "搜索消息",
        ):
            self.assertNotIn(token, index_html)
        self.assertNotIn("sidebarSearchBtn", app_js)
        self.assertNotIn("workspaceAddBtn", app_js)
        self.assertNotIn("openMessageSearch", app_js)
        self.assertNotIn("function initSearch", app_js)
        self.assertNotIn("#search-bar", styles)
        self.assertNotIn("search-highlight", styles)
        self.assertNotIn(".workspace-row", styles)

    def test_runtime_reset_is_available_while_session_is_busy(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("async function resetActiveSessionRuntime", app_js)
        self.assertIn("session/runtime/reset", app_js)
        self.assertNotIn("当前任务运行中，停止后可重置运行时。", app_js)

    def test_prompt_submit_queues_running_turn_without_interrupting(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("const wasBusy = !!runtime.busy", app_js)
        self.assertIn("async function sendPrompt(text, images = [], files = [], targetSession = null, options = {})", app_js)
        self.assertIn("const sess = targetSession || state.sessions.get(state.activeId)", app_js)
        self.assertIn("queued_status: wasBusy ? 'queued' : ''", app_js)
        self.assertIn("queue: wasBusy", app_js)
        self.assertIn("if (msg.state === 'queue')", app_js)
        self.assertIn("localUserMsg.id = acceptedUserId", app_js)
        self.assertIn("function queuedUserBadgeHtml(msg)", app_js)
        self.assertIn("等待上一工具调用结束", app_js)
        self.assertIn("force: false", app_js)
        self.assertIn("if (busy && (hasText || hasAttachments)) return '当前任务结束后发送';", app_js)
        self.assertNotIn("function enqueuePromptForIdle", app_js)
        self.assertNotIn("function flushQueuedPrompt", app_js)
        self.assertNotIn("force: wasBusy", app_js)
        self.assertNotIn("发送并中断当前任务", app_js)
        self.assertIn("const shouldSubmit = !runtime?.busy || inputEl.value.trim().length > 0 || state.pendingAttachmentCount > 0;", app_js)
        self.assertNotIn("if (runtime.busy) return;", app_js)
        self.assertNotIn("当前任务还在运行，按 Esc 或点击停止后再发送。", app_js)

    def test_unknown_bridge_session_state_adds_background_session_without_switching_active(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        ensure_fn = js_function_source(app_js, "ensureSessionForBridgeNotification")
        notify_fn = js_function_source(app_js, "handleNotification")

        self.assertIn("return upsertLocalSessionForBridgeSession(msg, msg.title || '后台会话')", ensure_fn)
        self.assertIn("function upsertLocalSessionForBridgeSession", app_js)
        self.assertNotIn("setActiveSession", ensure_fn)
        self.assertIn("const sess = ensureSessionForBridgeNotification(msg)", notify_fn)
        self.assertNotIn("const sess = findSessionByBridgeId(msg.sessionId)", notify_fn)

    def test_static_css_cache_version_is_current(self):
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        self.assertIn('styles.css?v=benchmark-cards-20261020"', index_html)
        self.assertIn('app.js?v=benchmark-cards-20261020"', index_html)
        self.assertNotIn('styles.css?v=turn-narrative-1"', index_html)
        self.assertNotIn('app.js?v=turn-narrative-1"', index_html)
        self.assertNotIn('styles.css?v=benchmark-entry-1"', index_html)
        self.assertNotIn('app.js?v=benchmark-entry-1"', index_html)
        self.assertNotIn('app.js?v=benchmark-entry-2"', index_html)
        self.assertNotIn('styles.css?v=session-delete-fix-2"', index_html)
        self.assertNotIn('app.js?v=session-delete-fix-2"', index_html)
        self.assertNotIn('styles.css?v=session-delete-brand-1"', index_html)
        self.assertNotIn('app.js?v=session-delete-brand-1"', index_html)
        self.assertNotIn('styles.css?v=blackboard-graph-13"', index_html)
        self.assertNotIn('app.js?v=blackboard-graph-13"', index_html)
        self.assertNotIn('styles.css?v=blackboard-graph-12"', index_html)
        self.assertNotIn('app.js?v=blackboard-graph-12"', index_html)
        self.assertNotIn('styles.css?v=blackboard-graph-11"', index_html)
        self.assertNotIn('app.js?v=blackboard-graph-11"', index_html)
        self.assertNotIn('styles.css?v=blackboard-graph-10"', index_html)
        self.assertNotIn('app.js?v=blackboard-graph-10"', index_html)
        self.assertNotIn('styles.css?v=blackboard-graph-9"', index_html)
        self.assertNotIn('app.js?v=blackboard-graph-9"', index_html)
        self.assertNotIn('styles.css?v=flow-map-1"', index_html)
        self.assertNotIn('styles.css?v=settings-b39"', index_html)
        self.assertNotIn('styles.css?v=settings-b38"', index_html)
        self.assertNotIn('styles.css?v=settings-b37"', index_html)
        self.assertNotIn('styles.css?v=settings-b36"', index_html)
        self.assertNotIn('styles.css?v=settings-b35"', index_html)
        self.assertNotIn('styles.css?v=settings-b34"', index_html)
        self.assertNotIn('styles.css?v=settings-b33"', index_html)
        self.assertNotIn('styles.css?v=settings-b32"', index_html)
        self.assertNotIn('styles.css?v=settings-b31"', index_html)
        self.assertNotIn('styles.css?v=settings-b30"', index_html)
        self.assertNotIn('styles.css?v=settings-b29"', index_html)
        self.assertNotIn('styles.css?v=settings-b28"', index_html)
        self.assertNotIn('styles.css?v=settings-b27"', index_html)
        self.assertNotIn('styles.css?v=settings-b26"', index_html)
        self.assertNotIn('styles.css?v=settings-b25"', index_html)
        self.assertNotIn('styles.css?v=settings-b24"', index_html)
        self.assertNotIn('styles.css?v=settings-b23"', index_html)
        self.assertNotIn('styles.css?v=settings-b22"', index_html)
        self.assertNotIn('styles.css?v=settings-b21"', index_html)
        self.assertNotIn('styles.css?v=settings-b20"', index_html)
        self.assertNotIn('styles.css?v=settings-b19"', index_html)
        self.assertNotIn('styles.css?v=settings-b18"', index_html)
        self.assertNotIn('styles.css?v=settings-b17"', index_html)
        self.assertNotIn('styles.css?v=settings-b16"', index_html)
        self.assertNotIn('styles.css?v=settings-b15"', index_html)
        self.assertNotIn('styles.css?v=settings-b14"', index_html)
        self.assertNotIn('styles.css?v=settings-b13"', index_html)
        self.assertNotIn('styles.css?v=settings-b12"', index_html)
        self.assertNotIn('styles.css?v=settings-b11"', index_html)
        self.assertNotIn('styles.css?v=settings-b10"', index_html)
        self.assertNotIn('styles.css?v=settings-b9"', index_html)
        self.assertNotIn('styles.css?v=settings-b8"', index_html)
        self.assertNotIn('styles.css?v=settings-b7"', index_html)
        self.assertNotIn('styles.css?v=settings-b6"', index_html)

    def test_blackboard_graph_replaces_linear_conversation_flow_copy(self):
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn('id="blackboard-graph-float"', index_html)
        self.assertIn('id="blackboard-graph-canvas"', index_html)
        self.assertIn('id="blackboard-graph-animation"', index_html)
        self.assertIn('id="blackboard-graph-svg"', index_html)
        self.assertIn('id="blackboard-graph-nodes"', index_html)
        self.assertIn('id="blackboard-graph-timeline"', index_html)
        self.assertIn("function blackboardGraphFromSession", app_js)
        self.assertIn("function layoutBlackboardGraph", app_js)
        self.assertIn("function blackboardTimelineEvents", app_js)
        self.assertIn("function renderBlackboardTimeline", app_js)
        self.assertIn("function renderBlackboardGraphCanvas", app_js)
        self.assertIn("function renderBlackboardGraph", app_js)
        self.assertIn(".blackboard-graph-float", styles)
        self.assertIn(".blackboard-graph-animation", styles)
        self.assertIn(".blackboard-graph-node.intent", styles)
        self.assertIn(".blackboard-graph-edge.concluded", styles)
        self.assertIn(".blackboard-graph-edge.open", styles)
        self.assertIn("@keyframes blackboardEdgeFlow", styles)
        self.assertNotIn("conversation-flow-float", index_html)
        self.assertNotIn("对话流程图", index_html)
        self.assertNotIn("conversationFlowNodesFromSession", app_js)
        self.assertNotIn("个步骤", app_js)

    def test_static_icon_buttons_use_svg_not_text_symbols(self):
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        for button_id in (
            "close-settings",
            "diagnostics-close",
            "error-dismiss",
        ):
            start = index_html.index(f'id="{button_id}"')
            open_tag_start = index_html.rfind("<button", 0, start)
            close_tag_end = index_html.index("</button>", start) + len("</button>")
            button_html = index_html[open_tag_start:close_tag_end]
            self.assertIn("<svg", button_html, msg=button_id)
            self.assertNotIn(">✕</button>", button_html, msg=button_id)
            self.assertNotIn(">▲</button>", button_html, msg=button_id)
            self.assertNotIn(">▼</button>", button_html, msg=button_id)

    def test_dynamic_close_buttons_use_svg_not_text_symbols(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("function closeIconSvg(size = 14)", app_js)
        self.assertIn("closeBtn.innerHTML = closeIconSvg(12)", app_js)
        self.assertIn("closeBtn.innerHTML = closeIconSvg(13)", app_js)
        self.assertIn("closeBtn.title = `关闭对话：${sess.title}`", app_js)
        self.assertIn("closeBtn.title = attachmentRemoveLabel('图片', img)", app_js)
        self.assertIn("closeBtn.title = attachmentRemoveLabel('文件', file)", app_js)
        self.assertIn("closeBtn.type = 'button'", app_js)
        self.assertNotIn("closeBtn.textContent = '×'", app_js)

    def test_session_tabs_use_keyboard_accessible_non_nested_buttons(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn("const item = document.createElement('div')", app_js)
        self.assertIn("const active = sess.id === state.activeId", app_js)
        self.assertIn("const busy = !!(runtime && runtime.busy)", app_js)
        self.assertIn("const tabStatus = busy ? '运行中' : '空闲'", app_js)
        self.assertIn("const tabLabel = `${sess.title}${roleLabel ? `，${roleLabel}${taskLabel}` : ''}，${tabStatus}${active ? '，当前对话' : ''}`", app_js)
        self.assertIn("item.setAttribute('role', 'tab')", app_js)
        self.assertIn("item.setAttribute('aria-label', tabLabel)", app_js)
        self.assertIn("item.title = tabLabel", app_js)
        self.assertIn("item.tabIndex = 0", app_js)
        self.assertIn("const closeBtn = document.createElement('button')", app_js)
        self.assertIn("closeBtn.setAttribute('aria-label', `关闭对话：${sess.title}`)", app_js)
        self.assertIn("closeBtn.title = `关闭对话：${sess.title}`", app_js)
        self.assertIn("item.addEventListener('keydown'", app_js)
        self.assertIn("if (e.target === item && (e.key === 'Enter' || e.key === ' '))", app_js)
        self.assertNotIn("const closeBtn = document.createElement('span')", app_js)
        self.assertNotIn("closeBtn.setAttribute('role', 'button')", app_js)
        self.assertIn(".session-tab .tab-close", styles)
        self.assertIn("background: transparent;", styles)
        self.assertIn(".session-tab:focus-visible", styles)
        self.assertIn(".session-tab .tab-close:focus-visible", styles)

    def test_sidebar_brand_replaces_main_topbar_title(self):
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn('<div id="sidebar-brand" class="sidebar-brand" aria-label="SecHeur Agent" role="button" tabindex="0" title="SecHeur Agent">', index_html)
        self.assertNotIn('<span class="workspace-title">SecHeur Agent</span>', index_html)
        self.assertNotIn('<h1 id="session-title" class="sr-only">SecHeur Agent</h1>', index_html)
        self.assertIn(".sidebar-brand", styles)
        self.assertIn("#topbar { display: none; }", styles)
        self.assertIn("const sidebarBrandEl = $('sidebar-brand')", app_js)
        self.assertIn("function setupBenchmarkDashboardShortcut", app_js)
        self.assertIn("if (clickCount >= 3)", app_js)
        self.assertIn("window.location.href = '/benchmark-dashboard/'", app_js)
        self.assertNotIn("const defaultSnapshot = existingSessions.find", app_js)
        self.assertIn("sessionStorage.getItem('secheur:active-session')", app_js)
        unguarded_title_writes = [
            line.strip()
            for line in app_js.splitlines()
            if "sessionTitleEl.textContent =" in line
            and "if (sessionTitleEl)" not in line
            and "if (sessionTitleEl &&" not in line
        ]
        self.assertEqual([], unguarded_title_writes)

    def test_benchmark_scenario_cards_share_the_welcome_template_and_open_overviews(self):
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertEqual(1, len(re.findall(r'<section\b[^>]*class="benchmark-entry-panel"', index_html)))
        self.assertIn("CTF BENCHMARK", index_html)
        self.assertIn("进入看板，查看 4 个安全场景的完整报告和最终结论。", index_html)
        cards = re.findall(r'<button\b[^>]*class="[^"]*\bscenario-grid-card\b[^"]*"[^>]*>', index_html, re.S)
        self.assertEqual(4, len(cards))
        for card in cards:
            self.assertIn('type="button"', card)
            self.assertIn('data-scenario-title="', card)
            self.assertIn('data-scenario-description="', card)
        for code, title in (
            ("REV-01", "逆向分析"),
            ("IR-02", "应急响应"),
            ("VULN-03", "漏洞挖掘"),
            ("PENTEST-04", "渗透测试"),
        ):
            self.assertEqual(1, index_html.count(f'data-benchmark-scenario="{code}"'))
            self.assertIn(title, index_html)
        dashboard_link = re.search(r'<a\b[^>]*id="benchmark-dashboard-btn"[^>]*>', index_html)
        self.assertIsNotNone(dashboard_link)
        self.assertIn('href="/benchmark-dashboard/"', dashboard_link.group(0))
        self.assertNotIn('aria-haspopup', dashboard_link.group(0))
        self.assertNotIn('data-benchmark-scenario', dashboard_link.group(0))
        self.assertIn("const benchmarkEntryPanelTemplate = document.querySelector('.benchmark-entry-panel')?.cloneNode(true)", app_js)
        render_fn = js_function_source(app_js, "renderMessages")
        self.assertIn("benchmarkEntryPanelTemplate.cloneNode(true)", render_fn)
        self.assertNotIn('class="benchmark-entry-panel"', render_fn)
        shortcut_fn = js_function_source(app_js, "setupBenchmarkDashboardShortcut")
        self.assertIn("event.target.closest('[data-benchmark-scenario]')", shortcut_fn)
        self.assertIn("openBenchmarkScenario(", shortcut_fn)
        self.assertRegex(index_html, r'<dialog\b[^>]*id="benchmark-scenario-dialog"')
        self.assertIn('id="benchmark-scenario-close"', index_html)
        self.assertIn('href="/benchmark-dashboard/"', index_html)
        self.assertIn(".scenario-grid-card", styles)
        self.assertIn(".scenario-grid-card:focus-visible", styles)
        self.assertNotIn(".benchmark-entry-chart", styles)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_benchmark_scenario_dialog_reads_card_data_without_reopening(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        open_fn = js_function_source(app_js, "openBenchmarkScenario")
        script = f"""
const assert = require('node:assert/strict');
const nodes = new Map(['code', 'title', 'description'].map((name) => [
  `benchmark-scenario-${{name}}`, {{ textContent: '' }}
]));
let showCount = 0;
const dialog = {{
  open: false,
  showModal() {{ showCount += 1; this.open = true; }}
}};
nodes.set('benchmark-scenario-dialog', dialog);
const $ = (id) => nodes.get(id);
{open_fn}
const target = {{ dataset: {{
  benchmarkScenario: 'REV-01',
  scenarioTitle: '逆向分析 · 授权校验程序',
  scenarioDescription: '<img src=x onerror=alert(1)> 静态与动态分析'
}} }};
openBenchmarkScenario(target);
assert.equal(showCount, 1);
assert.equal(nodes.get('benchmark-scenario-code').textContent, target.dataset.benchmarkScenario);
assert.equal(nodes.get('benchmark-scenario-title').textContent, target.dataset.scenarioTitle);
assert.equal(nodes.get('benchmark-scenario-description').textContent, target.dataset.scenarioDescription);
openBenchmarkScenario({{ dataset: {{ benchmarkScenario: 'ALL', scenarioTitle: '全部场景', scenarioDescription: '汇总' }} }});
assert.equal(showCount, 1);
assert.equal(nodes.get('benchmark-scenario-code').textContent, 'REV-01');
nodes.delete('benchmark-scenario-dialog');
assert.doesNotThrow(() => openBenchmarkScenario(target));
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(0, result.returncode, result.stderr)

    def test_removed_permission_settings_panel_has_no_stale_open_calls(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        self.assertNotIn("openSettings('permissions')", app_js)
        self.assertNotIn('data-settings-panel="permissions"', index_html)
        self.assertNotIn("/settings permissions", app_js)

    def test_settings_modal_declares_dialog_visibility_state(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        open_fn = js_function_source(app_js, "openSettings")
        close_fn = js_function_source(app_js, "closeSettings")

        self.assertIn('id="settings-modal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="settings-title" aria-hidden="true"', index_html)
        self.assertIn('<h2 id="settings-title">设置</h2>', index_html)
        self.assertIn("settingsModal.classList.remove('hidden')", open_fn)
        self.assertIn("settingsModal.setAttribute('aria-hidden', 'false')", open_fn)
        self.assertIn("settingsModal.classList.add('hidden')", close_fn)
        self.assertIn("settingsModal.setAttribute('aria-hidden', 'true')", close_fn)

    def test_diagnostics_panel_declares_dialog_visibility_state(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        open_fn = js_function_source(app_js, "openDiagnostics")
        close_fn = js_function_source(app_js, "closeDiagnostics")

        self.assertIn('id="diagnostics-panel" class="diagnostics-panel hidden" role="dialog" aria-modal="true" aria-labelledby="diagnostics-title" aria-hidden="true"', index_html)
        self.assertIn('<h2 id="diagnostics-title">诊断</h2>', index_html)
        self.assertIn("diagnosticsPanel.classList.remove('hidden')", open_fn)
        self.assertIn("diagnosticsPanel.setAttribute('aria-hidden', 'false')", open_fn)
        self.assertIn("diagnosticsPanel.classList.add('hidden')", close_fn)
        self.assertIn("diagnosticsPanel.setAttribute('aria-hidden', 'true')", close_fn)

    def test_status_badge_announces_status_changes(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        set_status_fn = js_function_source(app_js, "setStatus")

        self.assertIn('id="status-badge" class="badge" role="status" aria-live="polite" aria-atomic="true" aria-label="启动中…" title="启动中…"', index_html)
        self.assertIn("statusText.textContent = text", set_status_fn)
        self.assertIn("statusBadge.title = text", set_status_fn)
        self.assertIn("statusBadge.setAttribute('aria-label', text)", set_status_fn)

    def test_desktop_static_assets_do_not_use_stale_bridge_labels(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        bridge_js = (ROOT / "frontends" / "desktop" / "static" / "secheur-web.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        self.assertFalse((ROOT / "frontends" / "desktop" / "static" / "ga-web.js").exists())
        self.assertNotIn("GaBridge", app_js)
        self.assertNotIn("ga-web2", bridge_js)
        self.assertNotIn("web2 bridge", bridge_js)
        self.assertIn("secheur-web", bridge_js)
        self.assertIn("window.secheurAgent = secheurAgent", bridge_js)
        self.assertIn("case 'session/runtime/reset'", bridge_js)
        self.assertNotIn("window.ga", bridge_js)
        self.assertIn("secheur-web.js?v=bridge-adapter-11", index_html)
        self.assertNotIn("secheur-web.js?v=bridge-adapter-10", index_html)
        self.assertNotIn("secheur-web.js?v=bridge-adapter-9", index_html)
        self.assertNotIn("secheur-web.js?v=bridge-adapter-8", index_html)
        self.assertNotIn("secheur-web.js?v=bridge-adapter-7", index_html)
        self.assertNotIn("secheur-web.js?v=bridge-adapter-6", index_html)
        self.assertNotIn("secheur-web.js?v=bridge-adapter-5", index_html)
        self.assertNotIn("secheur-web.js?v=bridge-adapter-4", index_html)
        self.assertNotIn("secheur-web.js?v=bridge-adapter-3", index_html)
        self.assertNotIn("secheur-web.js?v=bridge-adapter-2", index_html)
        self.assertNotIn('secheur-web.js?v=bridge-adapter-1"', index_html)
        self.assertNotIn("ga-web.js", index_html)
        self.assertIn('app.js?v=benchmark-cards-20261020"', index_html)
        self.assertNotIn('app.js?v=turn-narrative-1"', index_html)
        self.assertNotIn('app.js?v=benchmark-entry-2"', index_html)
        self.assertNotIn('app.js?v=session-delete-fix-2"', index_html)
        self.assertNotIn('app.js?v=session-delete-brand-1"', index_html)
        self.assertNotIn('app.js?v=blackboard-graph-13"', index_html)
        self.assertNotIn('app.js?v=blackboard-graph-12"', index_html)
        self.assertNotIn('app.js?v=blackboard-graph-11"', index_html)
        self.assertNotIn('app.js?v=blackboard-graph-10"', index_html)
        self.assertNotIn('app.js?v=blackboard-graph-9"', index_html)
        self.assertNotIn('app.js?v=flow-map-1"', index_html)
        self.assertNotIn('app.js?v=bridge-api-89"', index_html)
        self.assertNotIn('app.js?v=bridge-api-88"', index_html)
        self.assertNotIn('app.js?v=bridge-api-87"', index_html)
        self.assertNotIn('app.js?v=bridge-api-86"', index_html)
        self.assertNotIn('app.js?v=bridge-api-85"', index_html)
        self.assertNotIn('app.js?v=bridge-api-84"', index_html)
        self.assertNotIn('app.js?v=bridge-api-83"', index_html)
        self.assertNotIn('app.js?v=bridge-api-82"', index_html)
        self.assertNotIn('app.js?v=bridge-api-81"', index_html)
        self.assertNotIn('app.js?v=bridge-api-80"', index_html)
        self.assertNotIn('app.js?v=bridge-api-79"', index_html)
        self.assertNotIn('app.js?v=bridge-api-78"', index_html)
        self.assertNotIn('app.js?v=bridge-api-77"', index_html)
        self.assertNotIn('app.js?v=bridge-api-76"', index_html)
        self.assertNotIn('app.js?v=bridge-api-75"', index_html)
        self.assertNotIn('app.js?v=bridge-api-74"', index_html)
        self.assertNotIn('app.js?v=bridge-api-73"', index_html)
        self.assertNotIn('app.js?v=bridge-api-72"', index_html)
        self.assertNotIn('app.js?v=bridge-api-71"', index_html)
        self.assertNotIn('app.js?v=bridge-api-70"', index_html)
        self.assertNotIn('app.js?v=bridge-api-69"', index_html)
        self.assertNotIn('app.js?v=bridge-api-68"', index_html)
        self.assertNotIn('app.js?v=bridge-api-67"', index_html)
        self.assertNotIn('app.js?v=bridge-api-66"', index_html)
        self.assertNotIn('app.js?v=bridge-api-65"', index_html)
        self.assertNotIn('app.js?v=bridge-api-64"', index_html)
        self.assertNotIn('app.js?v=bridge-api-63"', index_html)
        self.assertNotIn('app.js?v=bridge-api-62"', index_html)
        self.assertNotIn('app.js?v=bridge-api-61"', index_html)
        self.assertNotIn('app.js?v=bridge-api-60"', index_html)
        self.assertNotIn('app.js?v=bridge-api-59"', index_html)
        self.assertNotIn('app.js?v=bridge-api-58"', index_html)
        self.assertNotIn('app.js?v=bridge-api-57"', index_html)
        self.assertNotIn('app.js?v=bridge-api-56"', index_html)
        self.assertNotIn('app.js?v=bridge-api-55"', index_html)
        self.assertNotIn('app.js?v=bridge-api-54"', index_html)
        self.assertNotIn('app.js?v=bridge-api-53"', index_html)
        self.assertNotIn('app.js?v=bridge-api-52"', index_html)
        self.assertNotIn('app.js?v=bridge-api-51"', index_html)
        self.assertNotIn('app.js?v=bridge-api-50"', index_html)
        self.assertNotIn('app.js?v=bridge-api-49"', index_html)
        for version in range(1, 49):
            self.assertNotIn(f'app.js?v=bridge-api-{version}"', index_html)
        self.assertNotIn("app.js?v=session-cleanup-1", index_html)

    def test_composer_heuristic_learning_toggle_persists_and_wraps_backend_prompt_only(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")
        skill_md = ROOT / "skills" / "heuristic-learning" / "SKILL.md"

        self.assertTrue(skill_md.exists())
        self.assertIn("name: heuristic-learning", skill_md.read_text(encoding="utf-8"))
        self.assertIn('id="composer-heuristic-learning"', index_html)
        self.assertIn('aria-label="启用 heuristic-learning skill"', index_html)
        self.assertIn("启发式学习", index_html)
        self.assertIn(".composer-skill-toggle", styles)
        self.assertIn(".composer-skill-toggle input:checked + .composer-skill-toggle-pill", styles)
        self.assertIn("const composerHeuristicLearningToggle = $('composer-heuristic-learning')", app_js)
        self.assertIn("const HEURISTIC_LEARNING_SKILL_NAME = 'heuristic-learning'", app_js)
        self.assertIn("const HEURISTIC_LEARNING_STORAGE_KEY = 'secheur:heuristic-learning-enabled'", app_js)
        self.assertIn("function initHeuristicLearningToggle()", app_js)
        self.assertIn("function applyHeuristicLearningPrompt(text)", app_js)
        self.assertIn("displayPrompt: displayText", js_function_source(app_js, "sessionPromptPayload"))
        self.assertIn("const displayText = options.displayText ?? text", js_function_source(app_js, "sendPrompt"))
        self.assertIn("const backendText = options.backendText ?? displayText", js_function_source(app_js, "sendPrompt"))
        self.assertIn("content: displayText ||", js_function_source(app_js, "sendPrompt"))
        self.assertIn("sessionPromptPayload(sess, backendText, images, files, wasBusy, displayText)", js_function_source(app_js, "sendPrompt"))
        self.assertIn("sendPrompt(finalText, images, files, null, { backendText, displayText: finalText })", js_function_source(app_js, "submitInput"))
        self.assertIn("if (raw.startsWith('/')) return text", js_function_source(app_js, "applyHeuristicLearningPrompt"))

    def test_session_tabs_offer_export_and_runtime_log_actions(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        bridge_js = (ROOT / "frontends" / "desktop" / "static" / "secheur-web.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")
        render_sessions = js_function_source(app_js, "renderSessionList")

        self.assertIn('id="session-log-panel" class="session-log-panel hidden" role="dialog" aria-modal="true" aria-labelledby="session-log-title" aria-hidden="true"', index_html)
        self.assertIn('id="session-log-content"', index_html)
        self.assertIn("const sessionLogPanel = $('session-log-panel')", app_js)
        self.assertIn("async function exportSession(sessId)", app_js)
        self.assertIn("async function openSessionRunLog(sessId)", app_js)
        self.assertIn("function renderSessionRunLog(payload, sess)", app_js)
        self.assertIn("function closeSessionRunLog()", app_js)
        self.assertIn("function formatSessionExportMarkdown(payload)", app_js)
        self.assertIn("exportBtn.className = 'tab-action tab-export'", render_sessions)
        self.assertIn("logBtn.className = 'tab-action tab-log'", render_sessions)
        self.assertIn("exportBtn.setAttribute('aria-label', `导出对话：${sess.title}`)", render_sessions)
        self.assertIn("logBtn.setAttribute('aria-label', `查看运行日志：${sess.title}`)", render_sessions)
        self.assertIn("exportSession(sess.id)", render_sessions)
        self.assertIn("openSessionRunLog(sess.id)", render_sessions)
        self.assertIn("document.body.classList.add('session-log-open')", app_js)
        self.assertIn("document.body.classList.remove('session-log-open')", app_js)
        self.assertIn("case 'session/export'", bridge_js)
        self.assertIn("case 'session/runtime/log'", bridge_js)
        self.assertIn(".session-tab .tab-actions", styles)
        self.assertIn("opacity: 1;", styles)
        self.assertIn("background: var(--bg-hover);", styles)
        self.assertIn("color: var(--text-muted);", styles)
        self.assertIn(".session-tab .tab-action", styles)
        self.assertIn(".session-log-panel", styles)

    def test_blackboard_graph_button_is_icon_only_and_does_not_overlap_runtime_log(self):
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        toggle_match = re.search(
            r'<button id="blackboard-graph-toggle"(?P<attrs>[^>]*)>(?P<body>.*?)</button>',
            index_html,
            re.S,
        )
        self.assertIsNotNone(toggle_match)
        toggle_attrs = toggle_match.group("attrs")
        toggle_body = toggle_match.group("body")
        self.assertIn('title="展开黑板图"', toggle_attrs)
        self.assertIn('aria-label="展开黑板图"', toggle_attrs)
        self.assertIn("<svg", toggle_body)
        self.assertNotIn("<span", toggle_body)
        self.assertNotIn("黑板图", toggle_body)

        self.assertIn("body.session-log-open .blackboard-graph-float:not(.collapsed)", styles)
        expanded_block = styles[styles.index("body.session-log-open .blackboard-graph-float:not(.collapsed)"):]
        self.assertIn("right: max(592px, calc(env(safe-area-inset-right) + 592px));", expanded_block)
        self.assertIn("width: min(680px, calc(100vw - 624px));", expanded_block)
        self.assertIn(".blackboard-graph-float.collapsed", styles)
        collapsed_block = styles[styles.index(".blackboard-graph-float.collapsed"):]
        self.assertIn("width: 44px;", collapsed_block)
        self.assertIn("height: 44px;", collapsed_block)
        self.assertIn(".blackboard-graph-float.collapsed .blackboard-graph-head", styles)
        collapsed_head_block = styles[styles.index(".blackboard-graph-float.collapsed .blackboard-graph-head"):]
        self.assertIn("padding: 0;", collapsed_head_block)
        self.assertIn(".blackboard-graph-toggle", styles)
        toggle_style_block = styles[styles.index(".blackboard-graph-toggle"):]
        self.assertIn("width: 44px;", toggle_style_block)
        self.assertIn("height: 44px;", toggle_style_block)
        session_log_block = styles[styles.index(".session-log-panel"):]
        self.assertIn("z-index: 90;", session_log_block)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_apply_heuristic_learning_prompt_wraps_plain_text_but_not_slash_commands(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        functions = "\n".join(
            js_function_source(app_js, name)
            for name in (
                "isHeuristicLearningEnabled",
                "applyHeuristicLearningPrompt",
            )
        )
        script = f"""
const assert = require('assert');
const HEURISTIC_LEARNING_SKILL_NAME = 'heuristic-learning';
const HEURISTIC_LEARNING_PROMPT_PREFIX = `请先调用 skill 工具执行 ${{HEURISTIC_LEARNING_SKILL_NAME}}，然后严格使用该 skill 的方法完成下面任务。`;
let composerHeuristicLearningToggle = {{ checked: false }};
{functions}
assert.strictEqual(applyHeuristicLearningPrompt('改一下代码'), '改一下代码');
composerHeuristicLearningToggle.checked = true;
assert.strictEqual(applyHeuristicLearningPrompt('/help'), '/help');
const wrapped = applyHeuristicLearningPrompt('改一下代码');
assert.ok(wrapped.startsWith(HEURISTIC_LEARNING_PROMPT_PREFIX));
assert.ok(wrapped.endsWith('改一下代码'));
"""
        subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)

    def test_desktop_config_init_reads_nested_config_payload(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("saved?.config || saved", app_js)
        self.assertIn("projectRootFromPayload(saved)", app_js)

    def test_desktop_config_save_filters_runtime_root_fields(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("NON_PERSISTENT_CONFIG_KEYS", app_js)
        self.assertIn("'projectRoot'", app_js)
        self.assertNotIn("'gaRoot'", app_js)
        self.assertNotIn("bridgeApi.saveConfig(sess.config)", app_js)
        self.assertNotIn("bridgeApi.saveConfig(cfg)", app_js)

    def test_model_profiles_reconcile_deleted_model_selection(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("function reconcileModelSelectionAfterProfiles()", app_js)
        self.assertIn("const selectableProfiles = profiles.length ? profiles : [{ llmNo: 0 }]", app_js)
        self.assertIn("const validIds = new Set(selectableProfiles.map((profile) => modelProfileId(profile)))", app_js)
        self.assertNotIn("if (!profiles.length) return null;", app_js)
        self.assertIn("if (validIds.has(selected)) return null", app_js)
        self.assertIn("cfg.llmNo = 0", app_js)
        self.assertIn("await syncReconciledModelSelection(previousModelNo)", app_js)
        self.assertIn("bridgeApi.rpc('session/model', { sessionId: sess.bridgeSessionId, llmNo: 0 })", app_js)

    def test_save_settings_refreshes_registry_before_closing_modal(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        start = app_js.index("async function saveSettings()")
        end = app_js.index("async function applyRuntimeSettings()", start)
        fn = app_js[start:end]

        self.assertIn("await persistDesktopConfig(cfg)", fn)
        self.assertIn("await loadRegistry()", fn)
        self.assertLess(fn.index("await loadRegistry()"), fn.index("closeSettings()"))

    def test_composer_input_scrolls_after_height_limit(self):
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")
        start = styles.index("#input {")
        end = styles.index("#input::placeholder", start)
        block = styles[start:end]

        self.assertIn("max-height: 200px;", block)
        self.assertIn("overflow-y: auto;", block)

    def test_api_settings_do_not_prompt_manual_mykey_editing(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        bridge_js = (ROOT / "frontends" / "desktop" / "static" / "secheur-web.js").read_text(encoding="utf-8")

        api_panel_start = index_html.index('data-settings-panel="api"')
        api_panel_end = index_html.index('data-settings-panel="runtime"', api_panel_start)
        api_panel = index_html[api_panel_start:api_panel_end]

        self.assertIn('id="save-api-config"', api_panel)
        self.assertIn('id="clear-api-config"', api_panel)
        self.assertNotIn('id="open-mykey"', api_panel)
        self.assertNotIn("打开 mykey.py", api_panel)
        self.assertNotIn("$('open-mykey').addEventListener", app_js)
        self.assertNotIn("function openConfigFile", app_js)
        self.assertNotIn("openMykey: ()", bridge_js)
        self.assertIn("openMykeyTemplate: ()", bridge_js)
        self.assertIn("deleteApiConfig: (name) => rpc('app/api-config/delete'", bridge_js)
        self.assertIn("apiProfileAction: 'delete'", app_js)
        self.assertIn("function deleteApiProfileFromSettings(name)", app_js)

    def test_api_settings_can_fetch_models_and_select_from_dropdown(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        bridge_js = (ROOT / "frontends" / "desktop" / "static" / "secheur-web.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        api_panel_start = index_html.index('data-settings-panel="api"')
        api_panel_end = index_html.index('data-settings-panel="runtime"', api_panel_start)
        api_panel = index_html[api_panel_start:api_panel_end]

        self.assertIn('id="fetch-api-models"', api_panel)
        self.assertIn('id="cfg-api-model-select"', api_panel)
        self.assertIn("case 'app/api-config/models'", bridge_js)
        self.assertIn("fetchApiModels: (cfg) => rpc('app/api-config/models'", bridge_js)
        self.assertIn("function fetchApiModelsFromSettings()", app_js)
        self.assertIn("function renderFetchedApiModels", app_js)
        self.assertIn("bridgeApi.fetchApiModels(cfg)", app_js)
        self.assertIn("$('fetch-api-models')?.addEventListener('click'", app_js)
        self.assertIn("$('cfg-api-model-select')?.addEventListener('change'", app_js)
        self.assertIn("model: $('cfg-api-model')?.value || ''", app_js)
        self.assertIn("bridgeApi.deleteApiConfig(name)", app_js)

    def test_api_settings_can_test_model_response_from_current_form(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        bridge_js = (ROOT / "frontends" / "desktop" / "static" / "secheur-web.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        api_panel_start = index_html.index('data-settings-panel="api"')
        api_panel_end = index_html.index('data-settings-panel="runtime"', api_panel_start)
        api_panel = index_html[api_panel_start:api_panel_end]

        self.assertIn('id="test-api-response"', api_panel)
        self.assertIn("case 'app/api-config/test'", bridge_js)
        self.assertIn("testApiResponse: (cfg) => rpc('app/api-config/test'", bridge_js)
        self.assertIn("function testApiResponseFromSettings()", app_js)
        self.assertIn("bridgeApi.testApiResponse(cfg)", app_js)

    def test_api_model_fetch_allows_blank_form_key_when_saved_key_exists(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        start = app_js.index("function readApiFetchConfigFromSettings")
        end = app_js.index("function registryLabel", start)
        block = app_js[start:end]

        self.assertIn("savedApiKey", block)
        self.assertIn("state.apiConfig?.hasApiKey", block)
        self.assertIn("!cfg.apikey.trim() && !cfg.savedApiKey", block)
        self.assertNotIn("if (!cfg.apikey.trim())", block)
        self.assertIn("status.textContent = '正在获取模型列表…'", block)
        self.assertIn("addDiagnostic('error', '获取 API 模型失败'", block)

    def test_desktop_sessions_use_bridge_rpc_adapter(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        bridge_js = (ROOT / "frontends" / "desktop" / "static" / "secheur-web.js").read_text(encoding="utf-8")

        self.assertIn("case 'session/list'", bridge_js)
        self.assertIn("case 'session/delete'", bridge_js)
        self.assertIn("const bridgeApi = window.secheurAgent", app_js)
        self.assertIn("bridgeApi.rpc('session/delete'", app_js)
        self.assertIn("bridgeApi.rpc('session/list'", app_js)
        self.assertNotIn("window.ga", app_js)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_bridge_session_upsert_reuses_existing_local_tab(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        functions = "\n".join(
            js_function_source(app_js, name)
            for name in (
                "findSessionByBridgeId",
                "bridgeSessionIdFromPayload",
                "isClosedSessionId",
                "isClosedBridgeSessionId",
                "isOfflineSelfTestSessionSnapshot",
                "shouldIgnoreBridgeSessionSnapshot",
                "applyBridgeSessionSnapshot",
                "upsertLocalSessionForBridgeSession",
            )
        )
        script = f"""
const assert = require('assert');
let created = 0;
const state = {{
  activeId: null,
  defaultConfig: {{ llmNo: 0 }},
  sessions: new Map(),
  closedSessionIds: new Set(),
  closedBridgeSessionIds: new Set(),
}};
function isUntitledSessionTitle(title) {{ return !title || title === 'New chat' || title === '后台会话'; }}
function syncComposerApiModelFromSelectedProfile() {{}}
function getSessionRuntime() {{ return {{}}; }}
function renderSessionList() {{}}
function isActiveSession(sess) {{ return !!sess && sess.id === state.activeId; }}
const sessionTitleEl = {{ textContent: '' }};
function createLocalSession(id, title, bridgeSessionId = id, config = null) {{
  created += 1;
  const sess = {{
    id,
    title,
    bridgeSessionId,
    cwd: null,
    config: {{ ...state.defaultConfig, ...(config || {{}}) }},
    untitled: isUntitledSessionTitle(title),
  }};
  state.sessions.set(id, sess);
  return sess;
}}
{functions}
const first = createLocalSession('local-notify', '后台会话', 'sess-1', {{ llmNo: 1 }});
const reused = upsertLocalSessionForBridgeSession({{ id: 'sess-1', title: 'New chat', cwd: '/work', llmNo: 2 }}, 'New chat', {{ llmNo: 2 }});
assert.strictEqual(reused, first);
assert.strictEqual(created, 1);
assert.strictEqual(state.sessions.size, 1);
assert.strictEqual(reused.title, 'New chat');
assert.strictEqual(reused.cwd, '/work');
assert.strictEqual(reused.config.llmNo, 2);
const second = upsertLocalSessionForBridgeSession({{ id: 'sess-2', title: 'Another' }}, 'Restored', {{ llmNo: 3 }});
assert.notStrictEqual(second, first);
assert.strictEqual(created, 2);
assert.strictEqual(state.sessions.size, 2);
assert.strictEqual(second.bridgeSessionId, 'sess-2');
"""
        subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)

    def test_desktop_static_assets_do_not_use_ga_project_root_alias(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        bridge_js = (ROOT / "frontends" / "desktop" / "static" / "secheur-web.js").read_text(encoding="utf-8")

        self.assertNotIn("gaRoot", app_js)
        self.assertNotIn("selectGaRoot", bridge_js)
        self.assertNotIn("app/path/selectGaRoot", bridge_js)
        self.assertIn("selectProjectRoot", bridge_js)
        self.assertIn("app/path/selectProjectRoot", bridge_js)

    def test_mcp_settings_can_save_server_without_manual_file_edit(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        bridge_js = (ROOT / "frontends" / "desktop" / "static" / "secheur-web.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        self.assertIn('id="cfg-mcp-name"', index_html)
        self.assertIn('id="cfg-mcp-command"', index_html)
        self.assertIn('id="cfg-mcp-url"', index_html)
        self.assertIn('id="cfg-mcp-headers"', index_html)
        self.assertIn('id="cfg-mcp-cwd"', index_html)
        self.assertIn('id="save-mcp-config"', index_html)
        self.assertIn("case 'app/mcp-config/save'", bridge_js)
        self.assertIn("saveMcpConfig: (cfg) => rpc('app/mcp-config/save'", bridge_js)
        self.assertIn("function saveMcpConfigFromSettings()", app_js)
        self.assertIn("bridgeApi.saveMcpConfig(cfg)", app_js)
        self.assertIn("function fillMcpServer(name)", app_js)
        self.assertIn("'cfg-mcp-cwd'", app_js)
        self.assertIn("'cfg-mcp-url'", app_js)
        self.assertIn("url: $('cfg-mcp-url')?.value?.trim() || ''", app_js)
        self.assertIn("headers: readMcpHeaders()", app_js)
        self.assertIn("if (!cfg.command && !cfg.url) throw new Error('请输入启动命令或 HTTP URL')", app_js)
        self.assertIn("setValue('cfg-mcp-url', item.url || '')", app_js)
        self.assertIn("cwd: $('cfg-mcp-cwd')?.value?.trim() || ''", app_js)
        self.assertIn("setValue('cfg-mcp-cwd', item.cwd || '')", app_js)
        self.assertIn("registryAction: 'edit-mcp'", app_js)
        self.assertIn("deleteMcpConfig: (name) => rpc('app/mcp-config/delete'", bridge_js)
        self.assertIn("registryAction: 'delete-mcp'", app_js)
        self.assertIn("settings.json", index_html)
        self.assertIn("settings.local.json", index_html)
        self.assertIn(".secheur-agent/mcp.json", index_html)
        self.assertIn(".mcp.json", index_html)
        self.assertIn("扫描路径里还没有 MCP 配置。", app_js)

    def test_skill_settings_can_save_project_skill_without_manual_file_edit(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        bridge_js = (ROOT / "frontends" / "desktop" / "static" / "secheur-web.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        self.assertIn('id="cfg-skill-body"', index_html)
        self.assertIn('id="save-skill-config"', index_html)
        self.assertIn("新建 Skill 保存到 <code>.secheur-agent/skills/</code>", index_html)
        self.assertIn("case 'app/skill-config/save'", bridge_js)
        self.assertIn("saveSkillConfig: (cfg) => rpc('app/skill-config/save'", bridge_js)
        self.assertIn("function saveSkillConfigFromSettings()", app_js)
        self.assertIn("bridgeApi.saveSkillConfig(cfg)", app_js)
        self.assertIn("function fillSkillDefinition(name)", app_js)
        self.assertIn("registryAction: 'edit-skill'", app_js)
        self.assertIn("deleteSkillConfig: (name) => rpc('app/skill-config/delete'", bridge_js)
        self.assertIn("registryAction: 'delete-skill'", app_js)

    def test_agent_registry_is_visible_and_toggleable_in_settings(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        self.assertIn('data-settings-section="agents"', index_html)
        self.assertIn('data-settings-panel="agents"', index_html)
        self.assertIn('id="agents-registry-filter"', index_html)
        self.assertIn('id="agents-registry-list"', index_html)
        self.assertIn("registry: { mcpServers: [], skills: [], agents: [], tools: [], sources: {} }", app_js)
        self.assertIn("registryFilters: { mcpServers: '', skills: '', agents: '', tools: '' }", app_js)
        self.assertIn("renderRegistryList('agents', 'agents-registry-list', 'agents-list-count')", app_js)
        self.assertIn("agents: Array.isArray(result?.agents) ? result.agents : []", app_js)
        self.assertIn("'agents-registry-filter': 'agents'", app_js)

    def test_agent_settings_can_save_project_agent_without_manual_file_edit(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        bridge_js = (ROOT / "frontends" / "desktop" / "static" / "secheur-web.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        self.assertIn('id="cfg-agent-name"', index_html)
        self.assertIn('id="cfg-agent-body"', index_html)
        self.assertIn('id="save-agent-config"', index_html)
        self.assertIn("case 'app/agent-config/save'", bridge_js)
        self.assertIn("saveAgentConfig: (cfg) => rpc('app/agent-config/save'", bridge_js)
        self.assertIn("function saveAgentConfigFromSettings()", app_js)
        self.assertIn("bridgeApi.saveAgentConfig(cfg)", app_js)
        self.assertIn("function fillAgentDefinition(name)", app_js)
        self.assertIn("registryAction: 'edit-agent'", app_js)
        self.assertIn("deleteAgentConfig: (name) => rpc('app/agent-config/delete'", bridge_js)
        self.assertIn("registryAction: 'delete-agent'", app_js)

    def test_sub_agent_calls_render_as_expandable_dialog_cards(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn("SUB_AGENT_CALL", app_js)
        self.assertIn("SUB_AGENT_RESULT", app_js)
        self.assertIn("function parseSubAgentDetails", app_js)
        self.assertIn("function renderSubAgentDetailInto", app_js)
        self.assertIn("sub-agent-card", app_js)
        self.assertIn("子智能体", app_js)
        self.assertIn(".sub-agent-card", styles)
        self.assertIn(".sub-agent-transcript", styles)

    def test_temporary_sub_agent_dialog_renders_status_and_conversation(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        self.assertIn('id="temp-agent-float"', index_html)
        self.assertIn('id="temp-agent-float" class="temp-agent-float hidden" aria-label="临时智能体状态" aria-live="polite" aria-hidden="true"', index_html)
        self.assertIn('aria-controls="temp-agent-float-dialog" aria-expanded="true"', index_html)
        self.assertIn("TEMP_SUB_AGENT_DIALOG", app_js)
        self.assertIn("function parseTempSubAgentDetails", app_js)
        self.assertIn("function renderTempSubAgentDetailInto", app_js)
        self.assertIn("function updateTempSubAgentFloat", app_js)
        self.assertIn("tempAgentFloatEl.setAttribute('aria-hidden', 'false')", app_js)
        self.assertIn("tempAgentFloatEl.setAttribute('aria-hidden', 'true')", app_js)
        self.assertIn("tempAgentFloatToggleBtn.setAttribute('aria-expanded', String(!collapsed))", app_js)
        self.assertIn("tempAgentFloatToggleBtn.title = collapsed ? '展开' : '收起'", app_js)
        self.assertIn("tempAgentFloatEl", app_js)
        self.assertIn("temp-sub-agent-card", app_js)
        self.assertIn("temp-agent-float", app_js)
        self.assertIn("临时智能体", app_js)
        self.assertIn("主智能体", app_js)
        self.assertIn(".temp-sub-agent-card", styles)
        self.assertIn(".temp-agent-float", styles)
        self.assertIn(".temp-agent-float-dialog", styles)
        self.assertIn(".temp-sub-agent-message.agent", styles)

    def test_temporary_sub_agent_float_keeps_user_expand_state_when_messages_update(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("let tempAgentFloatUserCollapsed = null", app_js)
        self.assertIn("function setTempAgentFloatCollapsed", app_js)
        self.assertIn("setTempAgentFloatCollapsed(false, true)", app_js)
        self.assertIn("setTempAgentFloatCollapsed(true, true)", app_js)
        self.assertIn("tempAgentFloatUserCollapsed === true", app_js)
        self.assertIn("tempAgentFloatUserCollapsed !== false", app_js)
        self.assertIn("function syncTurnCollapseState", app_js)
        self.assertIn("syncTurnCollapseState(sess, turn)", app_js)

    def test_turn_headers_use_human_execution_stage_labels(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("function executionStageLabel(kind, text = '')", app_js)
        self.assertIn("const EXECUTION_STAGE_LABELS = {", app_js)
        self.assertIn("const TOOL_STAGE_RULES = [", app_js)
        self.assertIn("const STAGE_ONLY_SEGMENT_KINDS = new Set", app_js)
        self.assertIn("function turnNarrativeForSegment(seg)", app_js)
        self.assertIn("function syncTurnNarrative(turn, kind, text)", app_js)
        self.assertIn("syncTurnNarrative(turn, kind, seg.text)", app_js)
        self.assertIn("syncTurnNarrative(t, kind, t.dataset.buf || '')", app_js)
        self.assertNotIn("summarySpan.textContent = summary", app_js)
        self.assertIn("正在思考下一步", app_js)
        self.assertIn("正在查看项目文件", app_js)
        self.assertIn("正在执行命令", app_js)
        self.assertIn("正在让子智能体处理任务", app_js)
        self.assertIn("正在整理结果", app_js)
        self.assertIn("return `步骤 ${index}：${executionStageLabel(label)}`", app_js)
        self.assertNotIn("return `Turn ${index} : ${label || 'response'}`", app_js)
        self.assertNotIn("if (kind === 'LLM_RUNNING') return 'LLM Running';", app_js)

    def test_turn_headers_are_keyboard_accessible_disclosures(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn("function syncTurnDisclosureState(turn, header)", app_js)
        self.assertIn("function bindTurnDisclosure(turn, header, onCollapseChange = null)", app_js)
        self.assertIn("header.setAttribute('aria-expanded', String(!collapsed))", app_js)
        self.assertIn("header.title = collapsed ? '展开步骤详情' : '折叠步骤详情'", app_js)
        self.assertIn("const header = document.createElement('button')", app_js)
        self.assertIn("header.type = 'button'", app_js)
        self.assertIn("bindTurnDisclosure(turn, header, onCollapseChange)", app_js)
        self.assertIn("bindTurnDisclosure(node, header, () =>", app_js)
        self.assertIn("bindTurnDisclosure(detailTurn, header)", app_js)
        self.assertIn("syncTurnDisclosureState(t, t.querySelector('.turn-header'))", app_js)
        self.assertIn('<button class="turn-header" type="button">', app_js)
        self.assertIn(".turn-header:focus-visible", styles)
        self.assertIn("outline: 2px solid var(--accent);", styles)
        self.assertNotIn("const header = document.createElement('div');\n  header.className = 'turn-header'", app_js)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_execution_stage_label_maps_internal_states_to_chinese(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        start = app_js.index("const EXECUTION_STAGE_LABELS = {")
        end = app_js.index("function extractTagBodies", start)
        stage_code = app_js[start:end]
        script = f"""
const assert = require('assert');
{stage_code}
assert.strictEqual(summarizeStructuredBlock('LLM_RUNNING', '**LLM Running (Turn 2) ...**'), '正在思考下一步');
assert.strictEqual(turnHeaderLabel(1, 'LLM_RUNNING'), '步骤 1：正在思考下一步');
assert.strictEqual(turnLabelForSegment({{ kind: 'LLM_RUNNING', text: '<summary>先定位应用路径</summary>' }}, 0), '正在思考下一步');
assert.strictEqual(turnNarrativeForSegment({{ kind: 'LLM_RUNNING', text: '<summary>先定位应用路径</summary>' }}), '先定位应用路径');
assert.strictEqual(turnNarrativeForSegment({{ kind: 'agent_thought_chunk', text: '<summary>读取核心配置</summary>' }}), '读取核心配置');
assert.strictEqual(turnNarrativeForSegment({{ kind: 'agent_thought_chunk', text: '内部思考不应直接展示' }}), '');
assert.strictEqual(turnNarrativeForSegment({{ kind: 'LLM_RUNNING', text: '**LLM Running (Turn 2) ...**\\n我先检查安装目录。\\n<function_calls>' }}), '我先检查安装目录。');
const grouped = groupIntoTurns([{{ kind: 'LLM_RUNNING', text: '<summary>先定位应用路径</summary>' }}]);
assert.strictEqual(grouped.length, 2);
assert.strictEqual(grouped[0].type, 'turn');
assert.strictEqual(grouped[1].segment.text, '先定位应用路径');
assert.strictEqual(turnLabelForSegment({{ kind: 'TOOL_CALL', text: '<invoke name="file_read">' }}, 0), '正在查看项目文件');
assert.strictEqual(turnLabelForSegment({{ kind: 'TOOL_CALL', text: '<invoke name="code_run">' }}, 1), '正在执行命令');
assert.strictEqual(turnLabelForSegment({{ kind: 'TEMP_SUB_AGENT_DIALOG', text: '' }}, 2), '正在让子智能体处理任务');
assert.strictEqual(turnHeaderLabel(3, 'response'), '步骤 3：正在整理结果');
console.log('execution labels ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("execution labels ok", result.stdout)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_temp_sub_agent_float_update_preserves_expanded_state(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        functions = "\n".join(
            js_function_source(app_js, name)
            for name in (
                "escapeHtml",
                "tempSubAgentRoleLabel",
                "tempSubAgentStatusLabel",
                "setTempAgentFloatCollapsed",
                "closeTempSubAgentFloat",
                "toggleTempSubAgentFloat",
                "updateTempSubAgentFloat",
            )
        )
        script = f"""
const assert = require('assert');
function fakeEl() {{
  const classes = new Set();
  const attrs = new Map();
  return {{
    textContent: '',
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 100,
    title: '',
    setAttribute: (name, value) => attrs.set(name, String(value)),
    getAttribute: (name) => attrs.get(name),
    classList: {{
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {{
        const shouldAdd = force === undefined ? !classes.has(name) : !!force;
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
        return shouldAdd;
      }},
    }},
  }};
}}
const tempAgentFloatEl = fakeEl();
const tempAgentFloatTitleEl = fakeEl();
const tempAgentFloatStatusEl = fakeEl();
const tempAgentFloatDialogEl = fakeEl();
const tempAgentFloatToggleBtn = fakeEl();
let tempAgentFloatUserCollapsed = null;
let tempAgentFloatDialogId = null;
let tempAgentFloatHiddenDialogId = null;
{functions}
tempAgentFloatEl.classList.add('collapsed');
updateTempSubAgentFloat({{ agent: 'worker', status: 'running', messages: [{{ role: 'agent', text: 'one' }}] }});
assert.strictEqual(tempAgentFloatEl.classList.contains('collapsed'), true);
assert.strictEqual(tempAgentFloatEl.getAttribute('aria-hidden'), 'false');
toggleTempSubAgentFloat();
assert.strictEqual(tempAgentFloatEl.classList.contains('collapsed'), false);
assert.strictEqual(tempAgentFloatToggleBtn.getAttribute('aria-expanded'), 'true');
assert.strictEqual(tempAgentFloatToggleBtn.title, '收起');
updateTempSubAgentFloat({{ agent: 'worker', status: 'running', messages: [{{ role: 'agent', text: 'one' }}, {{ role: 'agent', text: 'two' }}] }});
assert.strictEqual(tempAgentFloatEl.classList.contains('collapsed'), false);
toggleTempSubAgentFloat();
assert.strictEqual(tempAgentFloatEl.classList.contains('collapsed'), true);
assert.strictEqual(tempAgentFloatToggleBtn.getAttribute('aria-expanded'), 'false');
assert.strictEqual(tempAgentFloatToggleBtn.title, '展开');
updateTempSubAgentFloat({{ agent: 'worker', status: 'running', messages: [{{ role: 'agent', text: 'three' }}] }});
assert.strictEqual(tempAgentFloatEl.classList.contains('collapsed'), true);
closeTempSubAgentFloat();
assert.strictEqual(tempAgentFloatEl.getAttribute('aria-hidden'), 'true');
console.log('temp sub agent float state ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("temp sub agent float state ok", result.stdout)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_temp_sub_agent_float_close_stays_hidden_for_same_dialog(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        functions = "\n".join(
            js_function_source(app_js, name)
            for name in (
                "escapeHtml",
                "tempSubAgentRoleLabel",
                "tempSubAgentStatusLabel",
                "setTempAgentFloatCollapsed",
                "closeTempSubAgentFloat",
                "updateTempSubAgentFloat",
            )
        )
        script = f"""
const assert = require('assert');
function fakeEl() {{
  const classes = new Set();
  const attrs = new Map();
  return {{
    textContent: '',
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 100,
    title: '',
    setAttribute: (name, value) => attrs.set(name, String(value)),
    getAttribute: (name) => attrs.get(name),
    classList: {{
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {{
        const shouldAdd = force === undefined ? !classes.has(name) : !!force;
        if (shouldAdd) classes.add(name);
        else classes.delete(name);
        return shouldAdd;
      }},
    }},
  }};
}}
const tempAgentFloatEl = fakeEl();
const tempAgentFloatTitleEl = fakeEl();
const tempAgentFloatStatusEl = fakeEl();
const tempAgentFloatDialogEl = fakeEl();
const tempAgentFloatToggleBtn = fakeEl();
let tempAgentFloatUserCollapsed = null;
let tempAgentFloatDialogId = null;
let tempAgentFloatHiddenDialogId = null;
{functions}
updateTempSubAgentFloat({{ id: 'tmp-1', agent: 'worker', status: 'running', messages: [{{ role: 'agent', text: 'one' }}] }});
assert.strictEqual(tempAgentFloatEl.getAttribute('aria-hidden'), 'false');
closeTempSubAgentFloat();
assert.strictEqual(tempAgentFloatEl.getAttribute('aria-hidden'), 'true');
updateTempSubAgentFloat({{ id: 'tmp-1', agent: 'worker', status: 'running', messages: [{{ role: 'agent', text: 'two' }}] }});
assert.strictEqual(tempAgentFloatEl.getAttribute('aria-hidden'), 'true');
assert.strictEqual(tempAgentFloatEl.classList.contains('hidden'), true);
updateTempSubAgentFloat({{ id: 'tmp-2', agent: 'worker', status: 'running', messages: [{{ role: 'agent', text: 'new' }}] }});
assert.strictEqual(tempAgentFloatEl.getAttribute('aria-hidden'), 'false');
assert.strictEqual(tempAgentFloatEl.classList.contains('hidden'), false);
console.log('temp sub agent close suppression ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("temp sub agent close suppression ok", result.stdout)

    def test_composer_add_button_opens_file_picker_and_handles_attachments(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn('id="composer-file-input"', index_html)
        self.assertIn('type="file"', index_html)
        self.assertIn("multiple", index_html)
        self.assertIn('aria-label="选择附件"', index_html)
        self.assertIn('id="composer-add-btn" class="composer-tool-btn" type="button" title="添加附件" aria-label="添加附件"', index_html)
        self.assertNotIn('accept="image/*', index_html)
        self.assertIn("const composerFileInput", app_js)
        self.assertIn("composerFileInput.click()", app_js)
        self.assertIn("function handleSelectedFiles", app_js)
        self.assertIn("pendingFiles", app_js)
        self.assertIn("readFileAttachment", app_js)
        self.assertIn("function formatFileSize", app_js)
        self.assertIn("function attachmentDisplayName(item, fallback = '附件')", app_js)
        self.assertIn("function attachmentTitle(item, fallback = '附件')", app_js)
        self.assertIn("function attachmentRemoveLabel(kind, item)", app_js)
        self.assertIn("return `移除${kind}：${attachmentDisplayName(item, kind)}`", app_js)
        self.assertIn("function setAttachmentSelectionBusy", app_js)
        self.assertIn("const addTitle = busy ? '正在读取附件…' : '添加附件'", app_js)
        self.assertIn("composerAddBtn.title = addTitle", app_js)
        self.assertIn("composerAddBtn.setAttribute('aria-label', addTitle)", app_js)
        self.assertIn("composerAddBtn.setAttribute('aria-busy', busy ? 'true' : 'false')", app_js)
        self.assertIn("files: files.map(file =>", app_js)
        self.assertIn("const imageAttachments = images.map(img => ({", app_js)
        self.assertIn("image_attachments: imageAttachments", app_js)
        self.assertIn("file_attachments: fileAttachments", app_js)
        self.assertIn("text || (fileAttachments.length || imageAttachments.length ? '已上传附件' : '')", app_js)
        self.assertIn("const hadAttachments = pendingImages.length > 0 || pendingFiles.length > 0", app_js)
        self.assertIn("const hasAttachments = state.pendingAttachmentCount > 0", app_js)
        self.assertIn("sendBtn.disabled = !busy && (attachmentBusy || (!hasText && !hasAttachments))", app_js)
        self.assertNotIn("sendBtn.disabled = attachmentBusy || (!hasText && !hasAttachments && !busy)", app_js)
        self.assertIn("text.startsWith('/') && !hadAttachments", app_js)
        self.assertIn("composerFileInput.addEventListener('change'", app_js)
        self.assertIn("wrapper.setAttribute('aria-label', `待发送图片：${attachmentTitle(img, '图片')}`)", app_js)
        self.assertIn("wrapper.setAttribute('aria-label', `待发送文件：${attachmentTitle(file, '文件')}`)", app_js)
        self.assertIn("pendingImages.push({ dataUrl, id, name: file.name || '粘贴的图片', size: file.size || 0 })", app_js)
        self.assertIn("size: file.size || 0", app_js)
        self.assertIn("closeBtn.setAttribute('aria-label', attachmentRemoveLabel('图片', img))", app_js)
        self.assertIn("closeBtn.setAttribute('aria-label', attachmentRemoveLabel('文件', file))", app_js)
        self.assertIn("aria-label=\"${escapeHtml(`已发送文件：${attachmentTitle(file, '文件')}`)}\"", app_js)
        self.assertIn("const imageAttachments = Array.isArray(msg.image_attachments) ? msg.image_attachments : []", app_js)
        self.assertIn("const imageInfo = imageAttachments.find((item) => item.id === id)", app_js)
        self.assertIn("const imageTitle = attachmentTitle(imageInfo || { id, name: '图片' }, '图片')", app_js)
        self.assertIn('alt="${escapeHtml(imageTitle)}" title="${escapeHtml(imageTitle)}"', app_js)
        self.assertIn(".file-preview-item", styles)
        self.assertIn(".file-preview-size", styles)

    def test_expired_image_placeholder_uses_svg_not_emoji(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn("function expiredImagePlaceholderHtml(imageInfo = null)", app_js)
        self.assertIn('class="user-msg-thumb-placeholder"', app_js)
        self.assertIn('role="img"', app_js)
        self.assertIn("const label = imageInfo ? `图片已过期：${attachmentTitle(imageInfo, '图片')}` : '图片已过期'", app_js)
        self.assertIn("const text = imageInfo ? attachmentDisplayName(imageInfo, '已过期') : '已过期'", app_js)
        self.assertIn('aria-label="${escapeHtml(label)}"', app_js)
        self.assertIn('title="${escapeHtml(label)}"', app_js)
        self.assertIn("<span>${escapeHtml(text)}</span>", app_js)
        self.assertIn("<svg viewBox=", app_js)
        self.assertIn("return expiredImagePlaceholderHtml(imageInfo)", app_js)
        self.assertNotIn("🖼", app_js)
        self.assertIn(".user-msg-thumb-placeholder", styles)
        self.assertIn(".user-msg-thumb-placeholder svg", styles)

    def test_copy_button_feedback_uses_plain_chinese_labels(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn("btn.textContent = '已复制'", app_js)
        self.assertIn("btn.setAttribute('aria-label', '代码已复制')", app_js)
        self.assertIn("btn.textContent = '复制失败'", app_js)
        self.assertIn("btn.setAttribute('aria-label', '复制代码失败')", app_js)
        self.assertIn("btn.setAttribute('aria-label', '复制代码')", app_js)
        self.assertNotIn("btn.textContent = '✓ 已复制'", app_js)
        self.assertNotIn("btn.textContent = '✗ 失败'", app_js)
        self.assertIn("pre .copy-btn:focus-visible", styles)

    def test_reduced_motion_preference_disables_motion(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn("function prefersReducedMotion()", app_js)
        self.assertIn("window.matchMedia?.('(prefers-reduced-motion: reduce)')", app_js)
        self.assertIn("smooth && !prefersReducedMotion() ? 'smooth' : 'auto'", app_js)
        self.assertIn("@media (prefers-reduced-motion: reduce)", styles)
        self.assertIn("animation: none !important;", styles)
        self.assertIn("scroll-behavior: auto !important;", styles)

    def test_long_assistant_messages_render_without_auto_fold_button(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertNotIn("const AUTO_FOLD_TEXT_CHARS", app_js)
        self.assertNotIn("const AUTO_FOLD_TEXT_LINES", app_js)
        self.assertNotIn("function shouldAutoFoldAssistantText", app_js)
        self.assertNotIn("function autoFoldSummaryText", app_js)
        self.assertNotIn("function renderAutoFoldMarkdownInto", app_js)
        self.assertNotIn("toggleAutoFoldBlock", app_js)
        self.assertNotIn("assistant-auto-fold", app_js)
        self.assertNotIn("展开全部", app_js)
        self.assertIn("renderStructuredMarkdownInto(body, stripGoalPlanBlocks(cleanContent), structuredRenderOptionsForSession(activeSess, false))", app_js)
        self.assertIn("renderStructuredMarkdownInto(body, stripGoalPlanBlocks(draft.text", app_js)
        self.assertIn("renderStructuredMarkdownInto(liveAssistant", app_js)
        self.assertNotIn(".assistant-auto-fold", styles)
        self.assertNotIn(".assistant-fold-toggle", styles)

    def test_default_theme_is_white(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        self.assertIn("theme: 'white'", app_js)
        self.assertIn("{ id: 'cfg-theme', key: 'theme', fallback: 'white' }", app_js)
        self.assertIn("cfg.theme || 'white'", app_js)
        self.assertIn('<html lang="zh-CN" data-theme="white">', index_html)
        self.assertIn('input id="cfg-theme" type="hidden" value="white"', index_html)
        self.assertNotIn("theme: 'auto'", app_js)

    def test_window_control_dots_are_removed(self):
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertNotIn("window-dot", index_html)
        self.assertNotIn(".window-dot", styles)
        self.assertNotIn("window-dot red", index_html)
        self.assertNotIn("window-dot yellow", index_html)
        self.assertNotIn("window-dot green", index_html)

    def test_send_button_uses_black_active_color(self):
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        send_blocks = re.findall(r"\.send-btn\s*\{[^}]+\}", styles)
        self.assertGreaterEqual(len(send_blocks), 2)
        self.assertTrue(all("background: var(--text);" in block for block in send_blocks))
        self.assertTrue(all("background: var(--text-faint);" not in block for block in send_blocks))
        self.assertIn(".send-btn.stop { background: var(--err); }", styles)

    def test_white_theme_empty_state_uses_light_surfaces(self):
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn("--empty-title:", styles)
        self.assertIn('[data-theme="white"] .empty-state', styles)
        self.assertIn('[data-theme="white"] #composer', styles)
        self.assertIn('[data-theme="white"] #input::placeholder', styles)
        self.assertIn("background: #ffffff;", styles)
        self.assertNotIn("--empty-card-bg:", styles)
        self.assertNotIn("--empty-card-icon-bg:", styles)
        self.assertNotIn("--empty-card-shadow:", styles)
        self.assertNotIn("background: var(--empty-action-bg)", styles)
        self.assertNotIn("background: #24232d", styles)
        self.assertNotIn("background: #22212b", styles)

    def test_composer_activity_tracks_agent_and_attachment_work(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn('id="composer-activity"', index_html)
        self.assertIn('id="composer" aria-busy="false"', index_html)
        self.assertIn('id="composer-activity" class="composer-activity hidden" role="status" aria-live="polite" aria-atomic="true"', index_html)
        self.assertIn('id="composer-activity-text"', index_html)
        self.assertIn("pendingAttachmentCount: 0", app_js)
        self.assertIn("attachmentSelectionBusy: false", app_js)
        self.assertIn("composerNoticeText: ''", app_js)
        self.assertIn("MODEL_FIRST_OUTPUT_WARNING_MS", app_js)
        self.assertIn("const MODEL_IDLE_WARNING_MS = 5 * 60 * 1000;", app_js)
        self.assertIn("lastAssistantActivityAt: 0", app_js)
        self.assertIn("stalledNoticeShown: false", app_js)
        self.assertIn("const composerEl = $('composer')", app_js)
        self.assertIn("function renderComposerActivity", app_js)
        self.assertIn("function maybeWarnModelStall", app_js)
        self.assertIn("markAssistantActivity(sess)", app_js)
        self.assertIn("const composerBusy = !!(state.attachmentSelectionBusy || runtime?.busy)", app_js)
        self.assertIn("composerEl.setAttribute('aria-busy', composerBusy ? 'true' : 'false')", app_js)
        self.assertIn("function flashComposerNotice", app_js)
        self.assertIn("function updateSessionStage", app_js)
        self.assertIn("composerActivityEl.dataset.kind = 'notice'", app_js)
        self.assertIn("runtime.currentStageText || '正在处理请求…'", app_js)
        self.assertNotIn("composerActivityTextEl.textContent = elapsed ? `${label} · ${elapsed}` : label", app_js)
        self.assertIn("composerActivityTextEl.textContent = ''", app_js)
        self.assertIn("function formatTaskElapsedPlain(ms)", app_js)
        self.assertIn("function taskElapsedAccessibleLabel(ms, ended)", app_js)
        self.assertIn("if (ended) return `完成 · ${elapsed}`", app_js)
        self.assertIn("return `${frame} 运行中 · ${elapsed}`", app_js)
        self.assertIn("return ended ? `任务完成，用时 ${elapsed}` : `任务运行中，用时 ${elapsed}`", app_js)
        self.assertIn('aria-label="${escapeHtml(label)}"', app_js)
        self.assertIn('title="${escapeHtml(label)}"', app_js)
        self.assertIn("badge.setAttribute('aria-label', label)", app_js)
        self.assertIn("badge.title = label", app_js)
        self.assertNotIn("Done ✓", app_js)
        self.assertIn("renderComposerActivity();", app_js)
        self.assertIn("正在发送请求…", app_js)
        self.assertIn("正在等待模型响应…", app_js)
        self.assertIn("正在接收回复", app_js)
        self.assertIn("等待模型首个输出超过", app_js)
        self.assertIn("模型输出已", app_js)
        self.assertIn("function resetActiveSessionRuntime", app_js)
        self.assertIn("bridgeApi.rpc('session/runtime/reset'", app_js)
        self.assertIn("showError(label, '重置运行时', () => resetActiveSessionRuntime(sess), { persist: true })", app_js)
        self.assertIn("queue: wasBusy", app_js)
        self.assertIn("等待上一工具调用结束", app_js)
        self.assertIn("if (busy && (hasText || hasAttachments)) return '当前任务结束后发送';", app_js)
        self.assertNotIn("force: wasBusy", app_js)
        self.assertNotIn("发送并中断当前任务", app_js)
        self.assertIn("sendBtn.classList.toggle('stop', busy && !hasText && !hasAttachments);", app_js)
        self.assertNotIn("showSystem('Agent 仍在回复", app_js)
        self.assertIn("state.attachmentSelectionBusy", app_js)
        self.assertIn(".composer-activity", styles)
        self.assertIn(".composer-activity-dot", styles)
        self.assertIn('.composer-activity[data-kind="agent_thought_chunk"]', styles)
        self.assertIn('.composer-activity[data-kind="agent_message_chunk"]', styles)
        self.assertIn('.composer-activity[data-kind="notice"]', styles)
        self.assertIn('.composer-activity[data-kind="stalled"]', styles)
        self.assertIn('.task-elapsed[data-ended="1"]', styles)

    def test_runtime_timeout_settings_are_registered(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        self.assertIn("agentOutputIdleTimeoutSeconds: 600", app_js)
        self.assertIn("agentFirstOutputTimeoutSeconds: 120", app_js)
        self.assertIn("{ id: 'cfg-agent-output-idle-timeout', key: 'agentOutputIdleTimeoutSeconds'", app_js)
        self.assertIn("{ id: 'cfg-agent-first-output-timeout', key: 'agentFirstOutputTimeoutSeconds'", app_js)
        self.assertIn('for="cfg-agent-output-idle-timeout"', index_html)
        self.assertIn('id="cfg-agent-output-idle-timeout"', index_html)
        self.assertIn('for="cfg-agent-first-output-timeout"', index_html)
        self.assertIn('id="cfg-agent-first-output-timeout"', index_html)

    def test_llm_running_turn_header_has_status_dot(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn("turn-status-dot", app_js)
        self.assertIn("llm-running", app_js)
        self.assertIn(".turn-status-dot", styles)
        self.assertIn(".turn-status-dot.busy", styles)

    def test_user_expanded_turns_are_not_auto_collapsed(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("turn.dataset.userExpanded", app_js)
        self.assertIn("seg.userExpanded", app_js)
        self.assertIn("!seg.userExpanded", app_js)
        self.assertIn("t.dataset.autoCollapse === '1' && t.dataset.userExpanded !== '1'", app_js)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_structured_turn_disclosure_state_survives_reparse(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        helpers = "\n".join(
            js_function_source(app_js, name)
            for name in (
                "turnDisclosureKey",
                "rememberTurnDisclosure",
                "restoreTurnDisclosure",
            )
        )
        script = f"""
{helpers}
const options = {{ disclosureState: new Map() }};
const first = {{ kind: 'LLM_RUNNING', text: 'LLM Running (Turn 2)' }};
const second = {{ kind: 'LLM_RUNNING', text: 'LLM Running (Turn 2)' }};
const key = turnDisclosureKey(first, 2);
rememberTurnDisclosure(options, key, true);
if (!restoreTurnDisclosure(options, turnDisclosureKey(second, 2))) {{
  throw new Error('disclosure state was not restored');
}}
rememberTurnDisclosure(options, key, false);
if (restoreTurnDisclosure(options, key)) {{
  throw new Error('collapsed state should clear user expansion');
}}
"""
        subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_structured_llm_running_turn_is_busy_while_rendering_active_draft(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        helpers = "\n".join(
            js_function_source(app_js, name)
            for name in (
                "isLlmRunningTurn",
                "isTurnBusy",
            )
        )
        script = f"""
{helpers}
if (!isTurnBusy({{ busy: true }}, 'LLM_RUNNING', 'LLM Running (Turn 3)', 'LLM Running (Turn 3)')) {{
  throw new Error('active LLM_RUNNING turn should be busy');
}}
if (isTurnBusy({{ busy: false }}, 'LLM_RUNNING', 'LLM Running (Turn 3)', 'LLM Running (Turn 3)')) {{
  throw new Error('inactive LLM_RUNNING turn should not be busy');
}}
if (!isTurnBusy({{ busy: true }}, 'agent_message_chunk', 'LLM Running (Turn 4)', 'LLM Running (Turn 4)')) {{
  throw new Error('marker parsed from assistant text should be busy');
}}
"""
        subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)

    def test_goal_plan_checklist_renders_from_assistant_protocol(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn('id="goal-plan-panel" class="goal-plan-panel hidden" aria-label="目标执行进度" aria-hidden="true"', index_html)
        self.assertIn('id="goal-plan-summary" class="goal-plan-summary" aria-live="polite" aria-atomic="true"', index_html)
        self.assertIn('id="goal-plan-list" class="goal-plan-list" aria-label="目标任务步骤"', index_html)
        self.assertIn('id="goal-plan-toggle"', index_html)
        self.assertIn("goalPlan: []", app_js)
        self.assertIn("goalPlanCollapsed: true", app_js)
        self.assertIn("function parseGoalPlanFromText", app_js)
        self.assertIn("function stripGoalPlanBlocks", app_js)
        self.assertIn("function updateSessionGoalPlanFromAssistantText", app_js)
        self.assertIn("function renderGoalPlan", app_js)
        self.assertIn("function toggleGoalPlanCollapsed", app_js)
        self.assertIn("goalPlanPanelEl.classList.toggle('collapsed', !!sess.goalPlanCollapsed)", app_js)
        self.assertIn("goalPlanToggleEl.setAttribute('aria-expanded', String(!sess.goalPlanCollapsed))", app_js)
        self.assertIn("goalPlanPanelEl.setAttribute('aria-hidden', 'true')", app_js)
        self.assertIn("goalPlanPanelEl.setAttribute('aria-hidden', 'false')", app_js)
        self.assertIn("goal-plan-item done", app_js)
        self.assertIn("renderGoalPlan()", app_js)
        self.assertIn("stripGoalPlanBlocks(cleanContent)", app_js)
        self.assertIn(".goal-plan-panel", styles)
        self.assertIn(".goal-plan-panel.collapsed .goal-plan-list", styles)
        self.assertIn(".goal-plan-item.done", styles)
        self.assertIn(".goal-plan-check", styles)

    def test_blackboard_graph_renders_as_top_right_floating_panel(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn('id="blackboard-graph-float" class="blackboard-graph-float collapsed" aria-label="黑板图" aria-live="polite"', index_html)
        self.assertIn('id="blackboard-graph-toggle"', index_html)
        self.assertIn('id="blackboard-graph-body"', index_html)
        self.assertIn('id="blackboard-graph-canvas"', index_html)
        self.assertIn('id="blackboard-graph-animation"', index_html)
        self.assertIn('id="blackboard-graph-svg"', index_html)
        self.assertIn('id="blackboard-graph-nodes"', index_html)
        self.assertIn('id="blackboard-graph-timeline"', index_html)
        self.assertIn("const blackboardGraphFloatEl = $('blackboard-graph-float')", app_js)
        self.assertIn("const blackboardGraphCanvasEl = $('blackboard-graph-canvas')", app_js)
        self.assertIn("const blackboardGraphAnimationCanvasEl = $('blackboard-graph-animation')", app_js)
        self.assertIn("const blackboardGraphTimelineEl = $('blackboard-graph-timeline')", app_js)
        self.assertIn("function blackboardGraphFromSession", app_js)
        self.assertIn("function layoutBlackboardGraph", app_js)
        self.assertIn("function renderBlackboardGraphCanvas", app_js)
        self.assertIn("function renderBlackboardGraph", app_js)
        self.assertIn("function toggleBlackboardGraphCollapsed", app_js)
        self.assertIn("renderBlackboardGraph()", app_js)
        self.assertIn("blackboardGraphToggleBtn.setAttribute('aria-expanded', String(!collapsed))", app_js)
        self.assertIn(".blackboard-graph-float", styles)
        self.assertIn(".blackboard-graph-float.collapsed .blackboard-graph-body", styles)
        self.assertIn(".blackboard-graph-canvas", styles)
        self.assertIn(".blackboard-graph-animation", styles)
        self.assertIn(".blackboard-graph-timeline", styles)
        self.assertIn(".blackboard-graph-node.intent", styles)
        self.assertIn(".blackboard-graph-node.open", styles)
        self.assertIn(".blackboard-graph-edge.open", styles)

    def test_blackboard_graph_has_canvas_animation_loop(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn('<canvas id="blackboard-graph-animation" class="blackboard-graph-animation" aria-hidden="true"></canvas>', index_html)
        for token in (
            "let blackboardGraphAnimationFrame = 0",
            "function blackboardEdgeCurve(edge)",
            "function blackboardBezierPoint(curve, t)",
            "function drawBlackboardGraphAnimation(layout, elapsedMs)",
            "function startBlackboardGraphAnimation(layout)",
            "function stopBlackboardGraphAnimation(clear = false)",
            "requestAnimationFrame(tick)",
            "cancelAnimationFrame(blackboardGraphAnimationFrame)",
        ):
            self.assertIn(token, app_js)
        self.assertIn("blackboardGraphAnimationCanvasEl.getContext('2d')", app_js)
        self.assertIn("blackboardGraphDrawFlowParticle", app_js)
        self.assertIn("blackboardGraphDrawNodePulse", app_js)
        self.assertIn("will-change: transform, opacity;", styles)

    def test_blackboard_graph_uses_cairn_style_motion(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        for token in (
            "function blackboardGraphIsRunning(graph)",
            "function blackboardGraphDrawGrid(ctx, width, height, elapsedMs)",
            "function blackboardGraphDrawScanBand(ctx, width, height, elapsedMs)",
            "function blackboardGraphDrawEdgeComet(ctx, edge, elapsedMs, index, pass = 0)",
            "const running = blackboardGraphIsRunning(graph)",
            "blackboardGraphCanvasEl.classList.toggle('is-running', running)",
            "for (let pass = 0; pass < 3; pass += 1)",
            "globalCompositeOperation = 'lighter'",
        ):
            self.assertIn(token, app_js)
        for token in (
            ".blackboard-graph-canvas.is-running",
            ".blackboard-graph-canvas::before",
            "@keyframes blackboardGraphSurfaceDrift",
            "@media (prefers-reduced-motion: reduce)",
        ):
            self.assertIn(token, styles)

    def test_blackboard_graph_expanded_state_has_dedicated_collapse_control(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn('id="blackboard-graph-collapse"', index_html)
        self.assertIn('aria-label="收起黑板图"', index_html)
        self.assertIn('aria-controls="blackboard-graph-body"', index_html)
        self.assertIn("const blackboardGraphCollapseBtn = $('blackboard-graph-collapse')", app_js)
        self.assertIn("function collapseBlackboardGraph()", app_js)
        self.assertIn("blackboardGraphCollapseBtn.addEventListener('click', collapseBlackboardGraph)", app_js)
        self.assertIn("blackboardGraphCollapseBtn.disabled = !!collapsed", app_js)
        self.assertIn(".blackboard-graph-collapse", styles)
        self.assertIn(".blackboard-graph-float.collapsed .blackboard-graph-collapse", styles)

    def test_blackboard_graph_inspector_stacks_on_narrow_viewports(self):
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn("@media (max-width: 760px)", styles)
        mobile_block = styles[styles.index("@media (max-width: 760px)"):]
        self.assertIn(".blackboard-graph-inspector", mobile_block)
        self.assertIn("grid-template-columns: 1fr;", mobile_block)
        self.assertIn("grid-template-rows: minmax(90px, auto) minmax(120px, 1fr);", mobile_block)
        self.assertIn(".blackboard-graph-inspector .blackboard-graph-detail", mobile_block)
        self.assertIn("border-right: 0;", mobile_block)

    def test_blackboard_graph_detail_markdown_timeline_scroll_and_full_background(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn('<div id="blackboard-graph-detail-body" class="blackboard-graph-detail-body"></div>', index_html)
        self.assertIn("blackboardGraphDetailBodyEl.innerHTML = renderMarkdown(detail)", app_js)
        self.assertNotIn("blackboardGraphDetailBodyEl.textContent = detail", app_js)
        self.assertIn(".blackboard-graph-detail-body :is(p, ul, ol, pre, table)", styles)
        self.assertIn(".blackboard-graph-timeline-list", styles)
        timeline_block = styles[styles.index(".blackboard-graph-timeline-list"):]
        self.assertIn("overflow-y: auto;", timeline_block)
        self.assertIn("overscroll-behavior: contain;", timeline_block)
        self.assertIn(".blackboard-graph-viewport::before", styles)
        self.assertIn("position: sticky;", styles[styles.index(".blackboard-graph-viewport::before"):])
        self.assertIn("min-width: max(100%, 920px);", styles)
        self.assertIn("min-height: max(100%, 420px);", styles)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_blackboard_graph_extracts_facts_intents_and_hints(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        start = app_js.index("function detectStructuredKind")
        end = app_js.index("// ─── Session management", start)
        graph_code = app_js[start:end]
        script = f"""
const assert = require('assert');
const state = {{ runtimeBySessionId: new Map() }};
function isActiveSession() {{ return false; }}
function renderGoalPlan() {{}}
function renderBlackboardGraph() {{}}
function stripGoalPlanBlocks(text) {{ return String(text || ''); }}
function decodeXmlText(value) {{ return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }}
function parseAttributesText(text) {{
  const attrs = {{}};
  String(text || '').replace(/([A-Za-z0-9_-]+)=["']([^"']*)["']/g, (_, key, value) => {{
    attrs[key] = decodeXmlText(value);
    return '';
  }});
  return attrs;
}}
function getSessionRuntime(sess) {{
  if (!state.runtimeBySessionId.has(sess.id)) state.runtimeBySessionId.set(sess.id, {{}});
  return state.runtimeBySessionId.get(sess.id);
}}
{graph_code}
const sess = {{
  id: 'local-test',
  title: '测试',
  messages: [
    {{ id: 1, role: 'user', content: '检查项目启动失败' }},
    {{ id: 2, role: 'assistant', content: '<function_calls>\\n<invoke name="code_run"><parameter name="args">npm test</parameter></invoke>\\n</function_calls>\\n已经定位问题。' }},
    {{ id: 3, role: 'user', content: '补充：先看日志' }}
  ]
}};
const graph = blackboardGraphFromSession(sess);
assert.strictEqual(graph.facts[0].id, 'origin');
assert.strictEqual(graph.facts[1].id, 'goal');
assert(graph.facts.some((fact) => fact.id === 'f001'), 'assistant fact missing');
assert(graph.intents.some((intent) => intent.to === 'f001'), 'intent edge missing');
assert.strictEqual(graph.hints[0].content, '补充：先看日志');
const layout = layoutBlackboardGraph(graph);
assert(layout.nodes.some((node) => node.id === 'origin' && node.kind === 'origin'), 'origin node missing');
assert(layout.nodes.some((node) => node.id === 'goal' && node.kind === 'goal'), 'goal node missing');
assert(layout.nodes.some((node) => node.kind === 'intent'), 'intent node missing');
assert(layout.edges.some((edge) => edge.kind === 'concluded'), 'concluded edge missing');
console.log('blackboard graph ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("blackboard graph ok", result.stdout)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_blackboard_graph_frontend_fallback_uses_clean_final_answer_summary(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        start = app_js.index("function detectStructuredKind")
        end = app_js.index("// ─── Session management", start)
        graph_code = app_js[start:end]
        script = f"""
const assert = require('assert');
const state = {{ runtimeBySessionId: new Map() }};
function isActiveSession() {{ return false; }}
function renderGoalPlan() {{}}
function renderBlackboardGraph() {{}}
function stripGoalPlanBlocks(text) {{ return String(text || ''); }}
function decodeXmlText(value) {{ return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }}
function parseAttributesText(text) {{
  const attrs = {{}};
  String(text || '').replace(/([A-Za-z0-9_-]+)=["']([^"']*)["']/g, (_, key, value) => {{
    attrs[key] = decodeXmlText(value);
    return '';
  }});
  return attrs;
}}
function getSessionRuntime(sess) {{
  if (!state.runtimeBySessionId.has(sess.id)) state.runtimeBySessionId.set(sess.id, {{}});
  return state.runtimeBySessionId.get(sess.id);
}}
{graph_code}
const sess = {{
  id: 'bilibili-summary-test',
  title: '查看 bilibili 热搜',
  messages: [
    {{ id: 1, role: 'user', content: '查看 bilibili 热搜' }},
    {{ id: 2, role: 'assistant', content: `
**LLM Running (Turn 1) ...**
<summary>The user wants to see the Bilibili hot search.</summary>

🛠️ Tool: \`code_run\`  📥 args:
\`\`\`\`text
{{ "type": "python", "script": "import urllib.request" }}
\`\`\`\`
\`\`\`\`\`
[Action] Running python in agent
[Status] ✅ Exit Code: 0
[Stdout]
🔥 Bilibili 热搜榜

 1. 地球往事  (12245136)
 2. 葡萄牙今晚能否首胜  (7039025)
\`\`\`\`\`

**LLM Running (Turn 2) ...**

🔥 **Bilibili 热搜榜** (2026-06-23)

| # | 热搜词 | 热度 |
|---|--------|------|
| 1 | 地球往事 | 1224万 |
| 2 | 葡萄牙今晚能否首胜 | 704万 |
` }},
  ],
}};
const graph = blackboardGraphFromSession(sess);
const fact = graph.facts.find((item) => item.sourceMessageId === 2);
assert(fact, 'assistant fact missing');
assert(fact.description.includes('Bilibili 热搜榜'), fact.description);
assert(fact.description.includes('地球往事'), fact.description);
assert(!fact.description.includes('LLM Running'), fact.description);
assert(!fact.description.includes('Tool:'), fact.description);
assert(!fact.description.includes('code_run'), fact.description);
assert(!fact.description.includes('script'), fact.description);
assert(!fact.description.includes('**'), fact.description);
console.log('blackboard clean final answer ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("blackboard clean final answer ok", result.stdout)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_blackboard_nodes_hide_body_and_detail_renders_markdown(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        start = app_js.index("function detectStructuredKind")
        end = app_js.index("// ─── Session management", start)
        graph_code = app_js[start:end]
        script = f"""
const assert = require('assert');
const state = {{ runtimeBySessionId: new Map() }};
function stripGoalPlanBlocks(text) {{ return String(text || ''); }}
function decodeXmlText(value) {{ return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }}
function parseAttributesText(text) {{ return {{}}; }}
function escapeHtml(value) {{ return String(value || '').replace(/[&<>"']/g, (ch) => ({{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }}[ch])); }}
function renderMarkdown(text) {{
  return String(text || '')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/^- (.*)$/gm, '<li>$1</li>');
}}
function getSessionRuntime(sess) {{
  if (!state.runtimeBySessionId.has(sess.id)) state.runtimeBySessionId.set(sess.id, {{}});
  return state.runtimeBySessionId.get(sess.id);
}}
const blackboardGraphCanvasEl = {{ style: {{}}, classList: {{ toggle() {{}} }} }};
const blackboardGraphAnimationCanvasEl = {{ style: {{}}, getContext() {{ return {{ clearRect() {{}}, setTransform() {{}}, createLinearGradient() {{ return {{ addColorStop() {{}} }}; }}, fillRect() {{}}, save() {{}}, restore() {{}}, beginPath() {{}}, moveTo() {{}}, lineTo() {{}}, stroke() {{}}, arc() {{}}, fill() {{}}, createRadialGradient() {{ return {{ addColorStop() {{}} }}; }}, bezierCurveTo() {{}}, translate() {{}}, rotate() {{}}, ellipse() {{}} }}; }}, width: 0, height: 0 }};
const blackboardGraphSvgEl = {{ innerHTML: '', setAttribute() {{}} }};
const blackboardGraphNodesEl = {{ innerHTML: '', querySelectorAll() {{ return []; }} }};
const blackboardGraphDetailEl = {{ classList: {{ remove() {{}}, add() {{}} }}, setAttribute() {{}} }};
const blackboardGraphDetailTitleEl = {{ textContent: '' }};
const blackboardGraphDetailBodyEl = {{ innerHTML: '', textContent: '' }};
const blackboardGraphTimelineEl = {{ innerHTML: '', querySelectorAll() {{ return []; }} }};
const window = {{ matchMedia() {{ return {{ matches: true }}; }}, devicePixelRatio: 1 }};
function cancelAnimationFrame() {{}}
function requestAnimationFrame() {{ return 1; }}
{graph_code}
const detail = '# 处理结果\\n\\n**重点**\\n\\n- 已完成';
const graph = {{
  project: {{ status: 'idle', origin: '目标', goal: '完成目标' }},
  facts: [
    {{ id: 'origin', kind: 'origin', description: '目标', detail: '目标' }},
    {{ id: 'goal', kind: 'goal', description: '完成目标', detail: '完成目标' }},
    {{ id: 'f001', kind: 'fact', description: '节点不应该显示这段正文', detail }},
  ],
  intents: [
    {{ id: 'i001', from: ['origin'], to: 'f001', description: '执行分析', detail: '执行分析', status: 'concluded', worker: 'SecHeur Agent' }},
  ],
  hints: [],
  summary: {{ factCount: 3, intentCount: 1, openIntentCount: 0 }},
}};
renderBlackboardGraphCanvas(graph);
assert(!blackboardGraphNodesEl.innerHTML.includes('节点不应该显示这段正文'), 'node DOM must not show body text');
assert(!blackboardGraphNodesEl.innerHTML.includes('blackboard-graph-node-body'), 'node body span should not be rendered');
const layout = layoutBlackboardGraph(graph);
const node = layout.nodes.find((item) => item.id === 'f001');
showBlackboardGraphNodeDetail(node);
assert(blackboardGraphDetailBodyEl.innerHTML.includes('<strong>重点</strong>'), blackboardGraphDetailBodyEl.innerHTML);
assert(blackboardGraphDetailBodyEl.innerHTML.includes('<li>已完成</li>'), blackboardGraphDetailBodyEl.innerHTML);
console.log('blackboard hidden node body markdown detail ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("blackboard hidden node body markdown detail ok", result.stdout)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_blackboard_fact_detail_preserves_long_final_answer_and_edge_labels_are_readable(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")
        start = app_js.index("function detectStructuredKind")
        end = app_js.index("// ─── Session management", start)
        graph_code = app_js[start:end]
        script = f"""
const assert = require('assert');
const state = {{ runtimeBySessionId: new Map() }};
function stripGoalPlanBlocks(text) {{ return String(text || ''); }}
function decodeXmlText(value) {{ return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }}
function parseAttributesText(text) {{ return {{}}; }}
function escapeHtml(value) {{ return String(value || '').replace(/[&<>"']/g, (ch) => ({{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }}[ch])); }}
function renderMarkdown(text) {{ return escapeHtml(text).replace(/\\n/g, '<br>'); }}
function getSessionRuntime(sess) {{
  if (!state.runtimeBySessionId.has(sess.id)) state.runtimeBySessionId.set(sess.id, {{}});
  return state.runtimeBySessionId.get(sess.id);
}}
const blackboardGraphDetailEl = {{ classList: {{ remove() {{}}, add() {{}} }}, setAttribute() {{}} }};
const blackboardGraphDetailTitleEl = {{ textContent: '' }};
const blackboardGraphDetailBodyEl = {{ innerHTML: '', textContent: '' }};
{graph_code}
const tail = 'FINAL_TAIL_MARKER';
const longAnswer = '最终结果：' + '完整答案段落。'.repeat(900) + tail;
const graph = {{
  project: {{ status: 'idle', origin: '目标', goal: '完成目标' }},
  facts: [
    {{ id: 'origin', kind: 'origin', description: '目标', detail: '目标' }},
    {{ id: 'goal', kind: 'goal', description: '完成目标', detail: '完成目标' }},
    {{ id: 'f001', kind: 'fact', description: '长最终答案', detail: longAnswer }},
  ],
  intents: [
    {{ id: 'i001', from: ['origin'], to: 'f001', description: '整理最终结果', detail: '整理最终结果', status: 'concluded', worker: 'SecHeur Agent' }},
  ],
  hints: [],
  summary: {{}},
}};
const layout = layoutBlackboardGraph(graph);
const fact = layout.nodes.find((node) => node.id === 'f001');
showBlackboardGraphNodeDetail(fact);
assert(blackboardGraphDetailBodyEl.innerHTML.includes(tail), 'clicked Fact detail should include the end of a long final answer');
assert(layout.width >= 920, `layout should leave readable horizontal space, got ${{layout.width}}`);
        const edge = layout.edges.find((item) => item.id === 'i001-f001');
        const label = blackboardRenderEdgeLabel(edge);
        assert(label.includes('blackboard-graph-edge-label-bg'), label);
        assert(label.includes('blackboard-graph-edge-label-text'), label);
        assert(label.includes('x="0" y="0"'), label);
        assert(!label.includes('dy='), label);
        assert(!label.includes('y="1"'), label);
        console.log('blackboard long fact detail and edge label ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("blackboard long fact detail and edge label ok", result.stdout)
        self.assertIn(".blackboard-graph-edge-label-bg", styles)
        self.assertIn(".blackboard-graph-edge-label-text", styles)
        self.assertIn("fill: color-mix(in srgb, var(--surface-raised) 94%, transparent);", styles)
        self.assertIn("text-anchor: middle;", styles)
        self.assertIn("dominant-baseline: central;", styles)
        self.assertIn("alignment-baseline: central;", styles)
        self.assertNotIn("alignment-baseline: baseline;", styles)
        self.assertNotIn("dominant-baseline: middle;", styles)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_blackboard_graph_clears_previous_session_dom_when_next_session_is_collapsed(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        start = app_js.index("function detectStructuredKind")
        end = app_js.index("// ─── Session management", start)
        graph_code = app_js[start:end]
        script = f"""
const assert = require('assert');
const state = {{ sessions: new Map(), activeId: null, runtimeBySessionId: new Map() }};
function stripGoalPlanBlocks(text) {{ return String(text || ''); }}
function decodeXmlText(value) {{ return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }}
function parseAttributesText(text) {{
  const attrs = {{}};
  String(text || '').replace(/([A-Za-z0-9_-]+)=["']([^"']*)["']/g, (_, key, value) => {{
    attrs[key] = decodeXmlText(value);
    return '';
  }});
  return attrs;
}}
function escapeHtml(value) {{ return String(value || '').replace(/[&<>"']/g, (ch) => ({{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }}[ch])); }}
function getSessionRuntime(sess) {{
  if (!state.runtimeBySessionId.has(sess.id)) state.runtimeBySessionId.set(sess.id, {{}});
  return state.runtimeBySessionId.get(sess.id);
}}
	const blackboardGraphFloatEl = {{ classList: {{ toggle() {{}} }} }};
	const blackboardGraphBodyEl = {{ setAttribute() {{}} }};
	const blackboardGraphToggleBtn = {{ setAttribute() {{}}, title: '' }};
	const blackboardGraphCollapseBtn = {{ setAttribute() {{}}, disabled: false, title: '' }};
	const blackboardGraphSummaryEl = {{ textContent: '' }};
	const blackboardGraphEmptyEl = {{ classList: {{ toggle() {{}}, add() {{}}, remove() {{}} }} }};
	const blackboardGraphCanvasEl = {{ style: {{}}, classList: {{ toggle() {{}}, add() {{}}, remove() {{}} }} }};
	const blackboardGraphAnimationCanvasEl = {{ style: {{}}, getContext() {{ return {{ clearRect() {{}}, setTransform() {{}}, createLinearGradient() {{ return {{ addColorStop() {{}} }}; }}, fillRect() {{}}, save() {{}}, restore() {{}}, beginPath() {{}}, moveTo() {{}}, lineTo() {{}}, stroke() {{}}, arc() {{}}, fill() {{}}, createRadialGradient() {{ return {{ addColorStop() {{}} }}; }}, bezierCurveTo() {{}}, translate() {{}}, rotate() {{}}, ellipse() {{}} }}; }}, width: 0, height: 0 }};
	const blackboardGraphSvgEl = {{ innerHTML: '', setAttribute() {{}} }};
	const blackboardGraphNodesEl = {{ innerHTML: '', querySelectorAll() {{ return []; }} }};
	const blackboardGraphDetailEl = {{ classList: {{ toggle() {{}}, remove() {{}}, add() {{}} }}, setAttribute() {{}} }};
	const blackboardGraphDetailTitleEl = {{ textContent: '' }};
	const blackboardGraphDetailBodyEl = {{ textContent: '' }};
	const window = {{}};
	function cancelAnimationFrame() {{}}
	function requestAnimationFrame() {{ return 1; }}
	{graph_code}
const sessionA = {{
  id: 'session-a',
  blackboardGraphCollapsed: false,
  messages: [
    {{ id: 1, role: 'user', content: 'A 会话目标' }},
    {{ id: 2, role: 'assistant', content: 'A 会话结果' }},
  ],
}};
const sessionB = {{
  id: 'session-b',
  blackboardGraphCollapsed: true,
  messages: [
    {{ id: 1, role: 'user', content: 'B 会话目标' }},
  ],
}};
	state.sessions.set(sessionA.id, sessionA);
	state.sessions.set(sessionB.id, sessionB);
	state.activeId = sessionA.id;
	renderBlackboardGraph();
	assert.ok(blackboardGraphNodesEl.innerHTML.includes('blackboard-graph-node'), 'session A graph must render nodes first');
	let graphBuildCount = 0;
	const originalBlackboardGraphFromSession = blackboardGraphFromSession;
	blackboardGraphFromSession = function(sess) {{
	  graphBuildCount += 1;
	  return originalBlackboardGraphFromSession(sess);
	}};
	state.activeId = sessionB.id;
	renderBlackboardGraph();
	assert.strictEqual(blackboardGraphNodesEl.innerHTML, '', 'collapsed session B must clear previous graph nodes');
	assert.strictEqual(graphBuildCount, 0, 'collapsed graph must skip expensive graph building');
	console.log('blackboard session isolation ok');
	"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("blackboard session isolation ok", result.stdout)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_blackboard_timeline_orders_events_and_selects_graph_nodes(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        start = app_js.index("function detectStructuredKind")
        end = app_js.index("// ─── Session management", start)
        graph_code = app_js[start:end]
        script = f"""
const assert = require('assert');
const state = {{ runtimeBySessionId: new Map() }};
function stripGoalPlanBlocks(text) {{ return String(text || ''); }}
function decodeXmlText(value) {{ return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }}
function parseAttributesText(text) {{ return {{}}; }}
function escapeHtml(value) {{ return String(value || '').replace(/[&<>"']/g, (ch) => ({{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }}[ch])); }}
function getSessionRuntime(sess) {{
  if (!state.runtimeBySessionId.has(sess.id)) state.runtimeBySessionId.set(sess.id, {{}});
  return state.runtimeBySessionId.get(sess.id);
}}
const nodeEls = new Map();
function makeNodeEl(id) {{
  return {{
    dataset: {{ nodeId: id }},
    classList: {{
      classes: new Set(),
      add(name) {{ this.classes.add(name); }},
      remove(name) {{ this.classes.delete(name); }},
      contains(name) {{ return this.classes.has(name); }},
    }},
    scrollIntoView() {{ this.scrolled = true; }},
  }};
}}
const blackboardGraphNodesEl = {{
  querySelector(selector) {{
    const match = String(selector).match(/data-node-id="([^"]+)"/);
    return match ? nodeEls.get(match[1]) : null;
  }},
  querySelectorAll() {{ return Array.from(nodeEls.values()); }},
}};
const blackboardGraphDetailEl = {{ classList: {{ remove() {{}}, add() {{}} }}, setAttribute() {{}} }};
const blackboardGraphDetailTitleEl = {{ textContent: '' }};
const blackboardGraphDetailBodyEl = {{ textContent: '' }};
const blackboardGraphTimelineEl = {{ innerHTML: '', querySelectorAll() {{ return []; }} }};
{graph_code}
const graph = {{
  project: {{ id: 'p1', title: '测试项目', status: 'running', origin: '用户目标', goal: '完成目标', created_at: '2026-06-23T10:00:00Z' }},
  facts: [
    {{ id: 'origin', kind: 'origin', description: '用户目标', created_at: '2026-06-23T10:00:00Z' }},
    {{ id: 'goal', kind: 'goal', description: '完成目标', created_at: '2026-06-23T10:00:00Z' }},
    {{ id: 'f001', kind: 'fact', description: '已经读取日志', created_at: '2026-06-23T10:00:01Z' }},
  ],
  hints: [
    {{ id: 'h001', content: '先看日志', creator: 'user', created_at: '2026-06-23T10:00:01Z' }},
  ],
  intents: [
    {{ id: 'i001', from: ['origin'], to: 'f001', description: '读取日志', creator: 'agent', worker: 'tool', status: 'concluded', created_at: '2026-06-23T10:00:01Z', concluded_at: '2026-06-23T10:00:01Z' }},
  ],
  summary: {{}},
}};
const events = blackboardTimelineEvents(graph);
assert.deepStrictEqual(events.map((event) => event.type), ['project_created', 'hint_added', 'intent_declared', 'intent_concluded']);
const layout = layoutBlackboardGraph(graph);
layout.nodes.forEach((node) => nodeEls.set(node.id, makeNodeEl(node.id)));
const concluded = events.find((event) => event.type === 'intent_concluded');
openBlackboardTimelineEntry(concluded, layout);
assert(nodeEls.get('f001').classList.contains('selected'), 'concluded event should select produced fact node');
assert.strictEqual(blackboardGraphDetailTitleEl.textContent, 'Fact');
assert(blackboardGraphDetailBodyEl.textContent.includes('已经读取日志'));
const declared = events.find((event) => event.type === 'intent_declared');
openBlackboardTimelineEntry(declared, layout);
assert(nodeEls.get('i001').classList.contains('selected'), 'declared event should select intent node');
assert.strictEqual(blackboardGraphDetailTitleEl.textContent, 'Intent i001');
console.log('blackboard timeline ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("blackboard timeline ok", result.stdout)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_blackboard_graph_nodes_use_short_labels_and_keep_full_text_in_detail(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        start = app_js.index("function detectStructuredKind")
        end = app_js.index("// ─── Session management", start)
        graph_code = app_js[start:end]
        script = f"""
const assert = require('assert');
const state = {{ runtimeBySessionId: new Map() }};
function stripGoalPlanBlocks(text) {{ return String(text || ''); }}
function decodeXmlText(value) {{ return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }}
function parseAttributesText(text) {{ return {{}}; }}
function getSessionRuntime(sess) {{
  if (!state.runtimeBySessionId.has(sess.id)) state.runtimeBySessionId.set(sess.id, {{}});
  return state.runtimeBySessionId.get(sess.id);
}}
const blackboardGraphDetailEl = {{ classList: {{ remove() {{}}, add() {{}} }}, setAttribute() {{}} }};
const blackboardGraphDetailTitleEl = {{ textContent: '' }};
const blackboardGraphDetailBodyEl = {{ textContent: '' }};
{graph_code}
const longText = '排查 Docker MCP 容器启动失败，需要检查镜像、端口、SSE 服务和权限。'.repeat(8);
const graph = {{
  project: {{ status: 'idle', origin: longText, goal: '完成排查' }},
  facts: [
    {{ id: 'origin', kind: 'origin', description: longText, detail: longText }},
    {{ id: 'goal', kind: 'goal', description: '完成排查', detail: '完成排查' }},
    {{ id: 'f001', kind: 'fact', description: longText, detail: longText }},
  ],
  intents: [
    {{ id: 'i001', from: ['origin'], to: 'f001', description: longText, detail: longText, status: 'concluded', worker: 'SecHeur Agent' }},
  ],
  hints: [],
  summary: {{}},
}};
const layout = layoutBlackboardGraph(graph);
const factNode = layout.nodes.find((node) => node.id === 'f001');
const intentNode = layout.nodes.find((node) => node.id === 'i001');
assert.strictEqual(factNode.title, 'Fact');
assert.strictEqual(intentNode.title, 'Intent i001');
assert(factNode.body.length <= 56, `fact node body should be short, got ${{factNode.body.length}}`);
assert(intentNode.body.length <= 56, `intent node body should be short, got ${{intentNode.body.length}}`);
assert(factNode.detail.length > factNode.body.length, 'full fact detail should be preserved outside compact node text');
showBlackboardGraphNodeDetail(factNode);
assert(blackboardGraphDetailBodyEl.textContent.includes('SSE 服务和权限'), 'detail should expose complete readable content');
console.log('blackboard compact labels ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("blackboard compact labels ok", result.stdout)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_blackboard_timeline_sorts_numeric_backend_timestamps_numerically(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        start = app_js.index("function detectStructuredKind")
        end = app_js.index("// ─── Session management", start)
        graph_code = app_js[start:end]
        script = f"""
const assert = require('assert');
const state = {{ runtimeBySessionId: new Map() }};
function stripGoalPlanBlocks(text) {{ return String(text || ''); }}
function decodeXmlText(value) {{ return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }}
function parseAttributesText(text) {{ return {{}}; }}
function getSessionRuntime(sess) {{
  if (!state.runtimeBySessionId.has(sess.id)) state.runtimeBySessionId.set(sess.id, {{}});
  return state.runtimeBySessionId.get(sess.id);
}}
const blackboardGraphDetailEl = {{ classList: {{ remove() {{}}, add() {{}} }}, setAttribute() {{}} }};
const blackboardGraphDetailTitleEl = {{ textContent: '' }};
const blackboardGraphDetailBodyEl = {{ textContent: '' }};
{graph_code}
const graph = {{
  project: {{ id: 'numeric-time', title: '数字时间戳', createdAt: 1 }},
  facts: [
    {{ id: 'origin', kind: 'origin', description: '目标', createdAt: 1 }},
    {{ id: 'goal', kind: 'goal', description: '完成', createdAt: 1 }},
    {{ id: 'f002', kind: 'fact', description: '第二步事实', createdAt: 2 }},
    {{ id: 'f010', kind: 'fact', description: '第十步事实', createdAt: 10 }},
  ],
  hints: [],
  intents: [
    {{ id: 'i002', from: ['origin'], to: 'f002', description: '第二步', createdAt: 2, concludedAt: 2, status: 'concluded' }},
    {{ id: 'i010', from: ['f002'], to: 'f010', description: '第十步', createdAt: 10, concludedAt: 10, status: 'concluded' }},
  ],
  summary: {{}},
}};
const events = blackboardTimelineEvents(graph);
const factEvents = events.filter((event) => event.type === 'intent_concluded').map((event) => event.targetId);
assert.deepStrictEqual(factEvents, ['f002', 'f010']);
console.log('blackboard numeric timeline ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("blackboard numeric timeline ok", result.stdout)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_blackboard_graph_preserves_full_detail_and_labels_structured_steps(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        start = app_js.index("function detectStructuredKind")
        end = app_js.index("// ─── Session management", start)
        graph_code = app_js[start:end]
        script = f"""
const assert = require('assert');
const state = {{ runtimeBySessionId: new Map() }};
function isActiveSession() {{ return false; }}
function renderGoalPlan() {{}}
function renderBlackboardGraph() {{}}
function stripGoalPlanBlocks(text) {{ return String(text || ''); }}
function getSessionRuntime(sess) {{
  if (!state.runtimeBySessionId.has(sess.id)) state.runtimeBySessionId.set(sess.id, {{}});
  return state.runtimeBySessionId.get(sess.id);
}}
const blackboardGraphDetailEl = {{ classList: {{ toggle() {{}}, remove() {{}}, add() {{}} }}, setAttribute() {{}} }};
const blackboardGraphDetailTitleEl = {{ textContent: '' }};
const blackboardGraphDetailBodyEl = {{ textContent: '' }};
{graph_code}
const longResult = '最终结论：' + '这个关键步骤必须完整保留，不能只显示前两行。'.repeat(14);
const sess = {{
  id: 'detail-test',
  title: '黑板图详情',
  messages: [
    {{ id: 1, role: 'user', content: '测试长内容和工具步骤是否准确' }},
    {{ id: 2, role: 'assistant', content: '<function_calls>\\n<invoke name="code_run"><parameter name="args">npm test -- --verbose</parameter></invoke>\\n</function_calls>\\n<function_results>\\n<result>所有测试通过，输出保留在详情里。</result>\\n</function_results>\\n' + longResult }},
  ],
}};
const graph = blackboardGraphFromSession(sess);
assert(graph.intents.some((intent) => intent.description === '正在执行命令' && intent.worker === 'code_run'), 'tool call should be labeled as an execution step');
assert(!graph.facts.some((fact) => /function_calls|invoke name/.test(fact.description || '')), 'raw tool XML should not leak into fact summaries');
const layout = layoutBlackboardGraph(graph);
const longNode = layout.nodes.find((node) => String(node.detail || '').includes('关键步骤必须完整保留'));
assert(longNode, 'long assistant result should have a detail node');
assert(longNode.detail.length > longNode.body.length, 'detail should preserve more content than the compact node body');
showBlackboardGraphNodeDetail(longNode);
assert.strictEqual(blackboardGraphDetailTitleEl.textContent, longNode.title);
assert(blackboardGraphDetailBodyEl.textContent.includes('关键步骤必须完整保留'), 'detail pane should show full node content');
console.log('blackboard detail ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("blackboard detail ok", result.stdout)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_blackboard_graph_does_not_auto_write_heavy_details_to_dom(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        start = app_js.index("function detectStructuredKind")
        end = app_js.index("// ─── Session management", start)
        graph_code = app_js[start:end]
        script = f"""
const assert = require('assert');
const state = {{ runtimeBySessionId: new Map() }};
function stripGoalPlanBlocks(text) {{ return String(text || ''); }}
function decodeXmlText(value) {{ return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }}
function parseAttributesText(text) {{
  const attrs = {{}};
  String(text || '').replace(/([A-Za-z0-9_-]+)=["']([^"']*)["']/g, (_, key, value) => {{
    attrs[key] = decodeXmlText(value);
    return '';
  }});
  return attrs;
}}
function escapeHtml(value) {{ return String(value || '').replace(/[&<>"']/g, (ch) => ({{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }}[ch])); }}
function getSessionRuntime(sess) {{
  if (!state.runtimeBySessionId.has(sess.id)) state.runtimeBySessionId.set(sess.id, {{}});
  return state.runtimeBySessionId.get(sess.id);
}}
const blackboardGraphCanvasEl = {{ style: {{}}, classList: {{ toggle() {{}} }} }};
const blackboardGraphAnimationCanvasEl = {{ style: {{}}, getContext() {{ return {{ clearRect() {{}}, setTransform() {{}}, createLinearGradient() {{ return {{ addColorStop() {{}} }}; }}, fillRect() {{}}, save() {{}}, restore() {{}}, beginPath() {{}}, moveTo() {{}}, lineTo() {{}}, stroke() {{}}, arc() {{}}, fill() {{}}, createRadialGradient() {{ return {{ addColorStop() {{}} }}; }}, bezierCurveTo() {{}}, translate() {{}}, rotate() {{}}, ellipse() {{}} }}; }}, width: 0, height: 0 }};
const blackboardGraphSvgEl = {{ innerHTML: '', setAttribute() {{}} }};
const renderedNodeEls = [];
const blackboardGraphNodesEl = {{
  innerHTML: '',
  querySelectorAll() {{ return renderedNodeEls; }},
}};
const blackboardGraphDetailEl = {{ classList: {{ remove() {{}}, add() {{}} }}, setAttribute() {{}} }};
const blackboardGraphDetailTitleEl = {{ textContent: '' }};
const blackboardGraphDetailBodyEl = {{ textContent: '' }};
const window = {{ matchMedia() {{ return {{ matches: true }}; }}, devicePixelRatio: 1 }};
function cancelAnimationFrame() {{}}
function requestAnimationFrame() {{ return 1; }}
{graph_code}
const huge = 'HEAVY_DETAIL_'.repeat(2000);
const graph = {{
  project: {{ status: 'idle', origin: '目标', goal: '目标' }},
  facts: [
    {{ id: 'origin', kind: 'origin', description: '目标' }},
    {{ id: 'f001', kind: 'fact', description: '短摘要', detail: huge }},
  ],
  intents: [
    {{ id: 'i001', from: ['origin'], to: 'f001', description: 'Agent 事实', detail: huge, status: 'concluded', worker: 'SecHeur Agent' }},
  ],
  hints: [],
  summary: {{ factCount: 2, intentCount: 1, openIntentCount: 0 }},
}};
renderBlackboardGraphCanvas(graph);
assert(!blackboardGraphNodesEl.innerHTML.includes('HEAVY_DETAIL_'), 'heavy detail must not be embedded in node DOM');
assert.strictEqual(blackboardGraphDetailBodyEl.textContent, '', 'detail pane must stay empty until user clicks a node');
showBlackboardGraphNodeDetail({{ title: 'Fact', body: '短摘要', detail: huge }});
assert(blackboardGraphDetailBodyEl.textContent.length < huge.length, 'clicked heavy detail should be bounded');
assert(blackboardGraphDetailBodyEl.textContent.includes('内容过长'), 'truncated detail should explain it was shortened');
console.log('blackboard heavy detail ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("blackboard heavy detail ok", result.stdout)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_blackboard_graph_layout_limits_large_history_and_defers_detail_cleaning(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        start = app_js.index("function detectStructuredKind")
        end = app_js.index("// ─── Session management", start)
        graph_code = app_js[start:end]
        script = f"""
const assert = require('assert');
const state = {{ runtimeBySessionId: new Map() }};
function stripGoalPlanBlocks(text) {{ return String(text || ''); }}
function decodeXmlText(value) {{ return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }}
function parseAttributesText(text) {{
  const attrs = {{}};
  String(text || '').replace(/([A-Za-z0-9_-]+)=["']([^"']*)["']/g, (_, key, value) => {{
    attrs[key] = decodeXmlText(value);
    return '';
  }});
  return attrs;
}}
function getSessionRuntime(sess) {{
  if (!state.runtimeBySessionId.has(sess.id)) state.runtimeBySessionId.set(sess.id, {{}});
  return state.runtimeBySessionId.get(sess.id);
}}
const blackboardGraphDetailEl = {{ classList: {{ remove() {{}}, add() {{}} }}, setAttribute() {{}} }};
const blackboardGraphDetailTitleEl = {{ textContent: '' }};
const blackboardGraphDetailBodyEl = {{ textContent: '' }};
{graph_code}
let detailCleanCount = 0;
const originalBlackboardCleanDetail = blackboardCleanDetail;
blackboardCleanDetail = function(...args) {{
  detailCleanCount += 1;
  return originalBlackboardCleanDetail(...args);
}};
const messages = [{{ id: 1, role: 'user', content: '目标' }}];
for (let i = 1; i <= 80; i += 1) {{
  messages.push({{ id: i + 1, role: 'assistant', content: `<think>${{'x'.repeat(6000)}}</think>详细事实 ${{i}}` }});
}}
const graph = blackboardGraphFromSession({{ id: 'large-history', title: '长历史', messages }});
assert.strictEqual(detailCleanCount, 0, 'graph building should not clean every heavy detail');
const layout = layoutBlackboardGraph(graph);
assert(layout.nodes.length <= 36, `large history should render a bounded graph, got ${{layout.nodes.length}} nodes`);
assert(layout.nodes.some((node) => node.id === 'origin'), 'origin must remain visible');
assert(layout.nodes.some((node) => node.id === 'goal'), 'goal must remain visible');
assert(layout.nodes.some((node) => node.id === 'f080'), 'latest fact must remain visible');
assert.strictEqual(detailCleanCount, 0, 'layout should not clean heavy details until the user clicks a node');
const latest = layout.nodes.find((node) => node.id === 'f080');
showBlackboardGraphNodeDetail(latest);
assert(detailCleanCount > 0, 'clicking a node should clean detail on demand');
assert(blackboardGraphDetailBodyEl.textContent.includes('详细事实 80'), 'clicked node detail should still be available');
console.log('blackboard bounded layout ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("blackboard bounded layout ok", result.stdout)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_blackboard_detail_cleaning_caps_source_before_regex_cleanup(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        start = app_js.index("function detectStructuredKind")
        end = app_js.index("// ─── Session management", start)
        graph_code = app_js[start:end]
        script = f"""
const assert = require('assert');
const state = {{ runtimeBySessionId: new Map() }};
function stripGoalPlanBlocks(text) {{ return String(text || ''); }}
function decodeXmlText(value) {{ return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }}
function parseAttributesText(text) {{
  const attrs = {{}};
  String(text || '').replace(/([A-Za-z0-9_-]+)=["']([^"']*)["']/g, (_, key, value) => {{
    attrs[key] = decodeXmlText(value);
    return '';
  }});
  return attrs;
}}
function getSessionRuntime(sess) {{
  if (!state.runtimeBySessionId.has(sess.id)) state.runtimeBySessionId.set(sess.id, {{}});
  return state.runtimeBySessionId.get(sess.id);
}}
const blackboardGraphDetailEl = {{ classList: {{ remove() {{}}, add() {{}} }}, setAttribute() {{}} }};
const blackboardGraphDetailTitleEl = {{ textContent: '' }};
const blackboardGraphDetailBodyEl = {{ textContent: '' }};
{graph_code}
stripGoalPlanBlocks = function(text) {{
  const value = String(text || '');
  if (value.length > 20000) throw new Error('detail cleanup received uncapped source');
  return value;
}};
const huge = 'VISIBLE_DETAIL\\n' + 'x'.repeat(750000);
const cleaned = blackboardCleanDetail(huge, 'fallback');
assert(cleaned.includes('VISIBLE_DETAIL'), 'front detail should remain visible');
assert(cleaned.length < 7000, `cleaned detail should be bounded, got ${{cleaned.length}}`);
assert(cleaned.includes('内容过长') || cleaned.includes('原始内容过长'), 'bounded detail should explain truncation');
console.log('blackboard detail source cap ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("blackboard detail source cap ok", result.stdout)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_blackboard_graph_from_session_only_processes_recent_history(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        start = app_js.index("function detectStructuredKind")
        end = app_js.index("// ─── Session management", start)
        graph_code = app_js[start:end]
        script = f"""
const assert = require('assert');
const state = {{ runtimeBySessionId: new Map() }};
function stripGoalPlanBlocks(text) {{ return String(text || ''); }}
function decodeXmlText(value) {{ return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }}
function parseAttributesText(text) {{
  const attrs = {{}};
  String(text || '').replace(/([A-Za-z0-9_-]+)=["']([^"']*)["']/g, (_, key, value) => {{
    attrs[key] = decodeXmlText(value);
    return '';
  }});
  return attrs;
}}
function getSessionRuntime(sess) {{
  if (!state.runtimeBySessionId.has(sess.id)) state.runtimeBySessionId.set(sess.id, {{}});
  return state.runtimeBySessionId.get(sess.id);
}}
{graph_code}
let splitCount = 0;
const originalSplitStructuredSegments = splitStructuredSegments;
splitStructuredSegments = function(text) {{
  splitCount += 1;
  return originalSplitStructuredSegments(text);
}};
const messages = [{{ id: 1, role: 'user', content: '目标' }}];
for (let i = 1; i <= 120; i += 1) {{
  messages.push({{ id: i + 1, role: 'assistant', content: `历史事实 ${{String(i).padStart(3, '0')}}` }});
}}
const graph = blackboardGraphFromSession({{ id: 'recent-history', title: '长历史', messages }});
assert(splitCount <= 40, `long history should not split every assistant message, got ${{splitCount}}`);
assert(graph.facts.some((fact) => String(fact.detail || fact.description).includes('历史事实 120')), 'latest fact must be preserved');
assert(!graph.facts.some((fact) => String(fact.detail || fact.description).includes('历史事实 001')), 'old fact should not be rebuilt for the compact graph');
console.log('blackboard recent history cap ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("blackboard recent history cap ok", result.stdout)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_blackboard_graph_idle_render_does_not_start_permanent_animation_loop(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        start = app_js.index("function detectStructuredKind")
        end = app_js.index("// ─── Session management", start)
        graph_code = app_js[start:end]
        script = f"""
const assert = require('assert');
const state = {{ runtimeBySessionId: new Map() }};
function stripGoalPlanBlocks(text) {{ return String(text || ''); }}
function decodeXmlText(value) {{ return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }}
function parseAttributesText(text) {{ return {{}}; }}
function escapeHtml(value) {{ return String(value || '').replace(/[&<>"']/g, (ch) => ({{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }}[ch])); }}
function getSessionRuntime(sess) {{
  if (!state.runtimeBySessionId.has(sess.id)) state.runtimeBySessionId.set(sess.id, {{}});
  return state.runtimeBySessionId.get(sess.id);
}}
const ctx = {{
  clearRect() {{}},
  setTransform() {{}},
  createLinearGradient() {{ return {{ addColorStop() {{}} }}; }},
  createRadialGradient() {{ return {{ addColorStop() {{}} }}; }},
  fillRect() {{}},
  save() {{}},
  restore() {{}},
  beginPath() {{}},
  moveTo() {{}},
  lineTo() {{}},
  stroke() {{}},
  arc() {{}},
  fill() {{}},
  bezierCurveTo() {{}},
  translate() {{}},
  rotate() {{}},
  ellipse() {{}},
}};
const blackboardGraphCanvasEl = {{ style: {{}}, classList: {{ toggle() {{}} }} }};
const blackboardGraphAnimationCanvasEl = {{ style: {{}}, getContext() {{ return ctx; }}, width: 0, height: 0 }};
const blackboardGraphSvgEl = {{ innerHTML: '', setAttribute() {{}} }};
const blackboardGraphNodesEl = {{ innerHTML: '', querySelectorAll() {{ return []; }} }};
const blackboardGraphDetailEl = {{ classList: {{ remove() {{}}, add() {{}} }}, setAttribute() {{}} }};
const blackboardGraphDetailTitleEl = {{ textContent: '' }};
const blackboardGraphDetailBodyEl = {{ textContent: '' }};
const window = {{ matchMedia() {{ return {{ matches: false }}; }}, devicePixelRatio: 1 }};
let requestedFrames = 0;
function cancelAnimationFrame() {{}}
function requestAnimationFrame() {{ requestedFrames += 1; return requestedFrames; }}
{graph_code}
const idleGraph = {{
  project: {{ status: 'idle', origin: '目标', goal: '目标' }},
  facts: [
    {{ id: 'origin', kind: 'origin', description: '目标' }},
    {{ id: 'f001', kind: 'fact', description: '事实' }},
  ],
  intents: [
    {{ id: 'i001', from: ['origin'], to: 'f001', description: 'Agent 事实', status: 'concluded', worker: 'SecHeur Agent' }},
  ],
  hints: [],
  summary: {{ factCount: 2, intentCount: 1, runningIntentCount: 0, openIntentCount: 0 }},
}};
renderBlackboardGraphCanvas(idleGraph);
assert.strictEqual(requestedFrames, 0, 'idle graph must draw once without scheduling animation frames');
const runningGraph = {{
  ...idleGraph,
  project: {{ status: 'running', origin: '目标', goal: '目标' }},
  summary: {{ factCount: 2, intentCount: 1, runningIntentCount: 1, openIntentCount: 0 }},
}};
renderBlackboardGraphCanvas(runningGraph);
assert(requestedFrames > 0, 'running graph should still animate');
console.log('blackboard idle animation ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("blackboard idle animation ok", result.stdout)

    def test_refresh_restore_updates_existing_assistant_partial_instead_of_duplicating_draft(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("function findMessageIndexByBridgeId(sess, msg)", app_js)
        self.assertIn("if (partial && msg.role === 'assistant')", app_js)
        self.assertIn("const existingIndex = findMessageIndexByBridgeId(sess, msg)", app_js)
        self.assertIn("sess.messages[existingIndex] = { ...sess.messages[existingIndex], ...msg, partial: true }", app_js)
        self.assertIn("runtime.lastPolledMessageId = Math.max(Number(runtime.lastPolledMessageId || 0), msg.id - 1)", app_js)
        self.assertIn("runtime.busy = msgRes?.status === 'running' || !!msgRes?.partial", app_js)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_polled_partial_updates_existing_assistant_message_after_reload(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        functions = "\n".join(
            js_function_source(app_js, name)
            for name in (
                "normalizeBridgeMessage",
                "findMessageIndexByBridgeId",
                "upsertPolledMessage",
            )
        )
        script = f"""
const assert = require('assert');
let renderCount = 0;
const runtime = {{ seenBridgeMessageIds: new Set(), lastPolledMessageId: 2, assistantDraft: null }};
function getSessionRuntime() {{ return runtime; }}
function updateSessionStage() {{}}
function markAssistantActivity() {{}}
function isActiveSession() {{ return true; }}
function renderMessages() {{ renderCount += 1; }}
function getAssistantDraft() {{
  throw new Error('existing partial must update the restored message, not create a draft');
}}
function renderAssistantDraftInPlace() {{
  throw new Error('existing partial must not render a duplicate draft');
}}
function renderMessage() {{
  throw new Error('existing partial must not append a duplicate message');
}}
function finalizeAssistantReply() {{
  throw new Error('partial update must not finalize');
}}
{functions}
const sess = {{
  messages: [
    {{ id: 1, role: 'user', content: 'hi' }},
    {{ id: 2, role: 'assistant', content: 'old partial' }},
  ],
}};
upsertPolledMessage(sess, {{ id: 2, role: 'assistant', content: 'new partial' }}, {{ partial: true }});
assert.strictEqual(sess.messages.length, 2);
assert.strictEqual(sess.messages[1].content, 'new partial');
assert.strictEqual(sess.messages[1].partial, true);
assert.strictEqual(runtime.lastPolledMessageId, 2);
assert.strictEqual(renderCount, 1);
console.log('partial reload update ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("partial reload update ok", result.stdout)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_goal_plan_parser_extracts_latest_plan_and_strips_protocol_blocks(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        functions = "\n".join(
            js_function_source(app_js, name)
            for name in (
                "decodeXmlText",
                "parseAttributesText",
                "goalPlanBlockRe",
                "normalizeGoalPlanStatus",
                "parseGoalPlanFromText",
                "stripGoalPlanBlocks",
            )
        )
        script = f"""
const assert = require('assert');
global.document = {{
  createElement() {{
    return {{
      textContent: '',
      set innerHTML(value) {{
        this.textContent = String(value || '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
      }}
    }};
  }}
}};
{functions}
const input = `说明
<goal_plan>
<item status="running">旧步骤</item>
</goal_plan>
继续
<goal_plan>
<item status="complete">检查 A&amp;B</item>
<item status="in_progress">实现</item>
<item status="todo">验证</item>
</goal_plan>`;
assert.deepStrictEqual(parseGoalPlanFromText(input), [
  {{ text: '检查 A&B', status: 'done' }},
  {{ text: '实现', status: 'running' }},
  {{ text: '验证', status: 'pending' }},
]);
assert.strictEqual(stripGoalPlanBlocks(input), '说明\\n\\n继续');
console.log('goal plan parser ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("goal plan parser ok", result.stdout)

    def test_registry_project_owned_detection_normalizes_windows_paths(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("function normalizedRegistryPath(item)", app_js)
        self.assertIn("replace(/\\\\/g, '/')", app_js)
        self.assertIn("const sourcePath = normalizedRegistryPath(item)", app_js)

    def test_bridge_close_status_uses_reason_fallback(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("function bridgeCloseReason(info)", app_js)
        self.assertIn("info?.code || info?.reason || 'unknown'", app_js)
        self.assertNotIn("${info.code}", app_js)

    def test_error_banner_hide_clears_auto_hide_timer(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        show_start = app_js.index("function showError(")
        hide_start = app_js.index("function hideError()", show_start)
        theme_start = app_js.index("// ─── Theme", hide_start)
        block = app_js[show_start:theme_start]

        self.assertIn("showError._t = setTimeout(() => hideError(), 6000)", block)
        self.assertIn("!options.persist", block)
        self.assertIn("function hideError()", block)
        self.assertIn("clearTimeout(showError._t)", block)
        self.assertIn("showError._t = null", block)
        self.assertIn("errorBanner.classList.add('hidden')", block)
        self.assertNotIn("setTimeout(() => errorBanner.classList.add('hidden')", block)

    def test_error_banner_is_announced_and_clears_stale_action(self):
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        show_start = app_js.index("function showError(")
        hide_start = app_js.index("function hideError()", show_start)
        block = app_js[show_start:hide_start]

        self.assertIn('id="error-banner" class="error-banner hidden" role="alert" aria-live="assertive" aria-atomic="true"', index_html)
        self.assertIn('class="icon-btn ghost hidden" id="error-action" type="button"', index_html)
        self.assertIn("actionBtn.textContent = ''", block)
        self.assertIn("actionBtn.onclick = null", block)

    def test_tauri_settings_use_secheur_agent_state_dir(self):
        lib_rs = (ROOT / "frontends" / "desktop" / "src-tauri" / "src" / "lib.rs").read_text(encoding="utf-8")

        self.assertIn('join(".secheur-agent")', lib_rs)
        self.assertIn('join("desktop-settings.json")', lib_rs)
        self.assertNotIn("legacy_settings_path", lib_rs)
        self.assertNotIn(".ga_desktop_settings.json", lib_rs)
        self.assertNotIn("/// Settings file path: ~/.ga_desktop_settings.json", lib_rs)

    def test_tauri_package_uses_secheur_name(self):
        cargo_toml = (ROOT / "frontends" / "desktop" / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
        cargo_lock = (ROOT / "frontends" / "desktop" / "src-tauri" / "Cargo.lock").read_text(encoding="utf-8")
        main_rs = (ROOT / "frontends" / "desktop" / "src-tauri" / "src" / "main.rs").read_text(encoding="utf-8")

        self.assertIn('name = "secheur-desktop"', cargo_toml)
        self.assertIn('name = "secheur_desktop_lib"', cargo_toml)
        self.assertIn('name = "secheur-desktop"', cargo_lock)
        self.assertIn("secheur_desktop_lib::run()", main_rs)
        self.assertNotIn("ga-desktop", cargo_toml)
        self.assertNotIn("ga-desktop", cargo_lock)
        self.assertNotIn("ga_desktop_lib", main_rs)

    def test_send_prompt_rolls_back_optimistic_message_on_failure(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("function rollbackOptimisticPrompt", app_js)
        self.assertIn("const previousTitle = sess.title", app_js)
        self.assertIn("const previousUntitled = sess.untitled", app_js)
        self.assertIn("rollbackOptimisticPrompt(sess, localUserMsg, previousTitle, previousUntitled)", app_js)
        self.assertIn("sess.messages.indexOf(localUserMsg)", app_js)

    def test_close_session_cleans_runtime_and_dom_cache(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("function cleanupClosedSessionState(id)", app_js)
        self.assertIn("state.runtimeBySessionId.delete(id)", app_js)
        self.assertIn("_domCache.delete(id)", app_js)
        self.assertIn("if (state._prevRenderedId === id) state._prevRenderedId = null", app_js)
        self.assertIn("cleanupClosedSessionState(id)", app_js)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_close_session_removes_target_without_tab_switch_side_effect(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        close_code = "\n".join(
            js_function_source(app_js, name)
            for name in (
                "rememberClosedSession",
                "isClosedSessionId",
                "isClosedBridgeSessionId",
                "shouldIgnoreBridgeSessionSnapshot",
                "cleanupClosedSessionState",
                "closeSession",
            )
        )
        script = f"""
const assert = require('assert');
let setActiveSessionCalls = 0;
let renderSessionListCalls = 0;
let renderMessagesCalls = 0;
const state = {{
  activeId: 'b',
  sessions: new Map([
    ['a', {{ id: 'a', bridgeSessionId: 'bridge-a', title: 'A' }}],
    ['b', {{ id: 'b', bridgeSessionId: 'bridge-b', title: 'B' }}],
    ['c', {{ id: 'c', bridgeSessionId: 'bridge-c', title: 'C' }}],
  ]),
  runtimeBySessionId: new Map([['b', {{ busy: false }}]]),
  closedSessionIds: new Set(),
  closedBridgeSessionIds: new Set(),
  _prevRenderedId: 'b',
}};
const _domCache = new Map([['b', {{ node: true }}]]);
const bridgeApi = {{ rpc(method, payload) {{ return Promise.resolve({{ method, payload }}); }} }};
const sessionTitleEl = {{ textContent: 'B' }};
function setActiveSession(id) {{
  setActiveSessionCalls += 1;
  state.activeId = id;
  renderMessages();
  renderSessionList();
}}
function forgetSessionPosition() {{}}
function persistSessionOrder() {{}}
function renderSessionList() {{ renderSessionListCalls += 1; }}
function renderMessages() {{ renderMessagesCalls += 1; }}
function renderGoalPlan() {{}}
function renderBlackboardGraph() {{}}
function renderDiagnostics() {{}}
function restoreComposerDraft() {{}}
function renderComposerControls() {{}}
function ensureComposerApiModelsForActiveSession() {{}}
function getSessionRuntime() {{ return {{ busy: false }}; }}
function setBusy() {{}}
{close_code}
closeSession('b');
assert.deepStrictEqual([...state.sessions.keys()], ['a', 'c']);
assert.strictEqual(state.sessions.has('b'), false);
assert.strictEqual(state.activeId, 'c');
assert.strictEqual(setActiveSessionCalls, 1, 'closeSession must load the adjacent session through setActiveSession');
assert.strictEqual(renderSessionListCalls, 1);
assert.strictEqual(renderMessagesCalls, 1);
assert.strictEqual(state.runtimeBySessionId.has('b'), false);
assert.strictEqual(_domCache.has('b'), false);
assert.strictEqual(state._prevRenderedId, null);
console.log('close session direct delete ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("close session direct delete ok", result.stdout)

    @unittest.skipIf(shutil.which("node") is None, "node is required for JS behavior test")
    def test_closed_session_notification_does_not_resurrect_deleted_tab(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        optional_names = (
            "rememberClosedSession",
            "isClosedSessionId",
            "isClosedBridgeSessionId",
            "isOfflineSelfTestSessionSnapshot",
            "shouldIgnoreBridgeSessionSnapshot",
        )
        bridge_code = "\n".join(
            js_function_source(app_js, name)
            for name in optional_names
            if f"function {name}(" in app_js
        )
        bridge_code += "\n" + "\n".join(
            js_function_source(app_js, name)
            for name in (
                "findSessionByBridgeId",
                "bridgeSessionIdFromPayload",
                "applyBridgeSessionSnapshot",
                "upsertLocalSessionForBridgeSession",
                "ensureSessionForBridgeNotification",
                "cleanupClosedSessionState",
                "closeSession",
            )
        )
        script = f"""
const assert = require('assert');
let created = 0;
const state = {{
  activeId: 'b',
  defaultConfig: {{ llmNo: 0 }},
  sessions: new Map([
    ['a', {{ id: 'a', bridgeSessionId: 'bridge-a', title: 'A', config: {{}} }}],
    ['b', {{ id: 'b', bridgeSessionId: 'bridge-b', title: 'B', config: {{}} }}],
    ['c', {{ id: 'c', bridgeSessionId: 'bridge-c', title: 'C', config: {{}} }}],
  ]),
  runtimeBySessionId: new Map([['b', {{ busy: false }}]]),
  closedSessionIds: new Set(),
  closedBridgeSessionIds: new Set(),
  _prevRenderedId: 'b',
}};
const _domCache = new Map([['b', {{ node: true }}]]);
const bridgeApi = {{ rpc(method, payload) {{ return Promise.resolve({{ method, payload }}); }} }};
const sessionTitleEl = {{ textContent: 'B' }};
function isUntitledSessionTitle(title) {{ return !title || title === 'New chat' || title === '后台会话'; }}
function syncComposerApiModelFromSelectedProfile() {{}}
function getSessionRuntime(sess) {{ return state.runtimeBySessionId.get(sess?.id) || {{ busy: false }}; }}
function renderSessionList() {{}}
function renderMessages() {{}}
function renderGoalPlan() {{}}
function renderBlackboardGraph() {{}}
function renderDiagnostics() {{}}
function restoreComposerDraft() {{}}
function renderComposerControls() {{}}
function ensureComposerApiModelsForActiveSession() {{}}
function setBusy() {{}}
function isActiveSession(sess) {{ return !!sess && sess.id === state.activeId; }}
function forgetSessionPosition() {{}}
function persistSessionOrder() {{}}
function setActiveSession(id) {{ state.activeId = id; }}
function createLocalSession(id, title, bridgeSessionId = id, config = null) {{
  created += 1;
  const sess = {{
    id,
    title,
    bridgeSessionId,
    cwd: null,
    config: {{ ...state.defaultConfig, ...(config || {{}}) }},
    untitled: isUntitledSessionTitle(title),
  }};
  state.sessions.set(id, sess);
  return sess;
}}
{bridge_code}
closeSession('b');
assert.deepStrictEqual([...state.sessions.keys()], ['a', 'c']);
const resurrected = ensureSessionForBridgeNotification({{
  type: 'session-state',
  sessionId: 'bridge-b',
  id: 'bridge-b',
  title: 'B',
  state: 'idle',
}});
assert.strictEqual(resurrected, null, 'closed bridge session notifications should be ignored');
assert.deepStrictEqual([...state.sessions.keys()], ['a', 'c']);
assert.strictEqual(created, 0);
console.log('closed session notification ignored ok');
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, text=True, capture_output=True, check=True)
        self.assertIn("closed session notification ignored ok", result.stdout)

    def test_recreated_bridge_session_keeps_model_permission_and_knowledge_settings(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("function sessionConfigPayload", app_js)
        self.assertIn("const permissionMode = COMPOSER_PERMISSION_LABELS[cfg.permissionMode] ? cfg.permissionMode : 'default'", app_js)
        self.assertIn("memoryReferenceEnabled: cfg.memoryReferenceEnabled !== false", app_js)
        self.assertIn("knowledgeBaseEnabled: cfg.knowledgeBaseEnabled === true", app_js)
        self.assertIn(
            "{ id: 'cfg-knowledge-base-enabled', key: 'knowledgeBaseEnabled', enabledByDefault: false }",
            app_js,
        )
        self.assertIn("...sessionConfigPayload(sess.config)", app_js)
        snapshot_fn = js_function_source(app_js, "applyBridgeSessionSnapshot")
        self.assertIn("if (snapshot.cwd) sess.cwd = snapshot.cwd", snapshot_fn)
        self.assertIn("if (snapshot.llmNo !== undefined) sess.config.llmNo = Number(snapshot.llmNo || 0)", snapshot_fn)
        self.assertIn("if (snapshot.permissionMode) sess.config.permissionMode = snapshot.permissionMode", snapshot_fn)
        self.assertIn("sess.config.memoryReferenceEnabled = snapshot.memoryReferenceEnabled !== false", snapshot_fn)
        self.assertIn("sess.config.knowledgeBaseEnabled = snapshot.knowledgeBaseEnabled === true", snapshot_fn)
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        self.assertIn('id="cfg-knowledge-base-enabled"', index_html)

    def test_settings_page_has_no_stale_model_selector_references(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        self.assertIn('id="composer-llm"', index_html)
        self.assertNotIn('id="cfg-llm"', index_html)
        self.assertNotIn("$('cfg-llm')", app_js)
        self.assertNotIn("cfg.llmNo = Math.max(0, parseInt($('cfg-llm')", app_js)

    def test_composer_permission_switch_exposes_all_backend_modes(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        for mode in ("default", "acceptEdits", "dontAsk", "bypassPermissions", "plan"):
            self.assertIn(f'<option value="{mode}">', index_html)
            self.assertIn(f"{mode}:", app_js)
        self.assertIn("acceptEdits: '自动接受编辑'", app_js)
        self.assertIn("plan: '计划模式'", app_js)

    def test_composer_model_can_switch_while_busy_but_permission_stays_locked(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn("const permissionLocked = busy || attachmentBusy", app_js)
        self.assertIn("const modelLocked = attachmentBusy", app_js)
        self.assertIn("composerPermissionSelect.disabled = permissionLocked", app_js)
        self.assertIn("composerModelSelect.disabled = modelLocked", app_js)
        self.assertIn("当前任务运行中，停止后可切换权限", app_js)
        self.assertNotIn("当前任务运行中，停止后可切换模型", app_js)
        self.assertIn("正在读取附件，稍后可切换权限", app_js)
        self.assertIn("正在读取附件，稍后可切换模型", app_js)
        self.assertIn("flashComposerNotice('当前任务运行中，停止后可切换权限模式。')", app_js)
        self.assertNotIn("flashComposerNotice('当前任务运行中，停止后可切换模型。')", app_js)
        self.assertNotIn("showSystem('Agent 正在回复，停止后再切换权限模式。')", app_js)
        self.assertNotIn("showSystem('Agent 正在回复，停止后再切换模型。')", app_js)
        self.assertIn(".composer-select-wrap select:disabled", styles)

    def test_composer_model_select_can_switch_models_inside_saved_api_profile(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        self.assertIn("apiModels: []", app_js)
        self.assertIn("apiModelsContextKey: ''", app_js)
        self.assertIn('id="composer-api-model"', index_html)
        self.assertIn("const composerApiModelSelect = $('composer-api-model')", app_js)
        self.assertIn("state.apiModels", app_js)
        self.assertIn("function renderApiModelOptions", app_js)
        self.assertIn("composerApiModelSelect.disabled = modelLocked || !apiModelOptionsAvailable()", app_js)
        self.assertIn("async function refreshComposerApiModels", app_js)
        self.assertIn("async function setComposerApiModel(modelId)", app_js)
        self.assertIn("composerApiModelSelect.addEventListener('change'", app_js)
        self.assertIn("sess.composerApiModelValue", app_js)
        self.assertIn("function composerApiContext", app_js)
        self.assertIn("function apiModelsContextKey", app_js)
        self.assertIn("function ensureComposerApiModelsForActiveSession", app_js)
        self.assertIn("ensureComposerApiModelsForActiveSession()", js_function_source(app_js, "setActiveSession"))
        self.assertIn("function syncComposerApiModelFromSelectedProfile", app_js)
        self.assertIn("syncComposerApiModelFromSelectedProfile(sess)", js_function_source(app_js, "setComposerModel"))
        self.assertIn("state.apiModels = []", js_function_source(app_js, "setComposerModel"))
        self.assertIn("await refreshComposerApiModels({ silent: true })", js_function_source(app_js, "setComposerModel"))
        self.assertIn("const context = composerApiContext(sess)", js_function_source(app_js, "setComposerApiModel"))
        self.assertIn("const context = composerApiContext()", js_function_source(app_js, "activeApiFetchConfig"))
        self.assertIn("const cfg = activeApiFetchConfig()", js_function_source(app_js, "refreshComposerApiModels"))
        self.assertIn("renderSendButtonState()", js_function_source(app_js, "refreshComposerApiModels"))
        self.assertIn("state.apiModelsContextKey === apiModelsContextKey(activeApiFetchConfig())", js_function_source(app_js, "apiModelOptionsAvailable"))
        self.assertIn("await bridgeApi.saveApiConfig(cfg)", app_js)
        self.assertIn("await loadModelProfiles()", app_js)
        self.assertIn("await bridgeApi.rpc('session/model'", app_js)
        self.assertNotIn("apiModelOptionValue", app_js)
        self.assertNotIn("apiModelIdFromOptionValue", app_js)
        self.assertNotIn("opt.value = apiModelOptionValue(model.id)", js_function_source(app_js, "renderModelOptions"))

    def test_composer_model_dropdowns_open_upward(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn("function setupComposerPopupSelect", app_js)
        self.assertIn("function syncComposerPopupSelect", app_js)
        self.assertIn("setupComposerPopupSelect(composerModelSelect, '模型')", app_js)
        self.assertIn("setupComposerPopupSelect(composerApiModelSelect, 'API 模型')", app_js)
        self.assertIn("syncComposerPopupSelect(composerModelSelect)", js_function_source(app_js, "renderModelOptions"))
        self.assertIn("syncComposerPopupSelect(composerApiModelSelect)", js_function_source(app_js, "renderApiModelOptions"))
        self.assertIn("syncComposerPopupSelect(composerModelSelect)", js_function_source(app_js, "renderSendButtonState"))
        self.assertIn("syncComposerPopupSelect(composerApiModelSelect)", js_function_source(app_js, "renderSendButtonState"))
        self.assertIn(".composer-popup-select-list", styles)
        self.assertIn("bottom: calc(100% + 8px)", styles)
        self.assertIn(".composer-popup-select-native", styles)
        self.assertIn("transition: border-color 0.15s, box-shadow 0.15s;\n  overflow: visible;", styles)

    def test_session_tabs_use_project_shield_icon(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")
        shield_path = "M786.29 745.36c-94.78 142.39-268.28 206.38-274.69 213.1"
        old_chat_path = "M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"

        self.assertIn("function projectShieldIconSvg", app_js)
        self.assertIn(shield_path, js_function_source(app_js, "projectShieldIconSvg"))
        self.assertIn('fill="#d87945"', js_function_source(app_js, "projectShieldIconSvg"))
        self.assertIn("icon.innerHTML = projectShieldIconSvg()", app_js)
        self.assertIn("icon.className = 'tab-icon'", app_js)
        self.assertNotIn("dot.className = 'tab-dot'", app_js)
        self.assertNotIn(old_chat_path, js_function_source(app_js, "projectShieldIconSvg"))
        self.assertIn(".session-tab .tab-icon", styles)
        self.assertIn(".session-tab .tab-icon svg", styles)
        self.assertNotIn(".session-tab .tab-dot", styles)

    def test_empty_state_has_no_recent_conversation_card(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        for source in (app_js, index_html, styles):
            self.assertNotIn("recent-heading", source)
            self.assertNotIn("recent-card", source)
            self.assertNotIn("recent-icon", source)
            self.assertNotIn("recent-title", source)
            self.assertNotIn("recent-text", source)
        self.assertNotIn("SecHeur Agent <span>开源项目</span>", app_js)
        self.assertNotIn("SecHeur Agent <span>开源项目</span>", index_html)
        self.assertNotIn("输入消息，或输入 <code>/help</code>", app_js)
        self.assertNotIn("输入消息，或输入 <code>/help</code>", index_html)

    def test_new_local_session_inherits_request_config(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("function createLocalSession(id, title, bridgeSessionId = id, config = null)", app_js)
        self.assertIn("const mergedConfig = { ...state.defaultConfig, ...(config || {}) }", app_js)
        self.assertIn("composerModelValue: String(mergedConfig.llmNo || 0)", app_js)
        self.assertIn("syncComposerApiModelFromSelectedProfile(sess)", js_function_source(app_js, "createLocalSession"))
        self.assertIn("createdSess = upsertLocalSessionForBridgeSession", app_js)
        self.assertIn("const ns = upsertLocalSessionForBridgeSession", app_js)

    def test_selecting_session_does_not_change_recency(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        set_active_fn = js_function_source(app_js, "setActiveSession")

        self.assertNotIn("touchSessionRecency(sess)", set_active_fn)
        self.assertIn("bridgeApi.rpc('session/activate'", set_active_fn)

    def test_composer_draft_is_preserved_per_session(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("composerDraft: { text: '', images: [], files: [] }", app_js)
        self.assertIn("function saveActiveComposerDraft()", app_js)
        self.assertIn("function restoreComposerDraft(sess)", app_js)
        self.assertIn("function clearActiveComposerDraft()", app_js)
        self.assertIn("saveActiveComposerDraft();", app_js)
        self.assertIn("restoreComposerDraft(sess);", app_js)
        self.assertIn("images: pendingImages.map((item) => ({ ...item }))", app_js)
        self.assertIn("files: pendingFiles.map((item) => ({ ...item }))", app_js)
        self.assertIn("pendingImages.push(...(Array.isArray(draft.images)", app_js)
        self.assertIn("pendingFiles.push(...(Array.isArray(draft.files)", app_js)
        self.assertIn("resizeComposerInput();", app_js)
        self.assertIn("clearActiveComposerDraft();", app_js)

    def test_background_messages_do_not_force_scroll_when_reader_is_above_bottom(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        styles = (ROOT / "frontends" / "desktop" / "static" / "styles.css").read_text(encoding="utf-8")

        self.assertIn('id="new-content-btn"', index_html)
        self.assertIn('aria-label="跳到最新消息" title="跳到最新消息" aria-hidden="true" tabindex="-1"', index_html)
        self.assertIn("const newContentBtn = $('new-content-btn')", app_js)
        self.assertIn("function renderMessage(msg, append = true, forceScroll = false)", app_js)
        self.assertIn("const shouldScroll = append && (forceScroll || isNearBottom())", app_js)
        self.assertIn("function scrollOrNotifyNewContent", app_js)
        self.assertIn("function showNewContentButton", app_js)
        self.assertIn("function hideNewContentButton", app_js)
        self.assertIn("newContentBtn.setAttribute('aria-hidden', 'false')", app_js)
        self.assertIn("newContentBtn.tabIndex = 0", app_js)
        self.assertIn("newContentBtn.setAttribute('aria-hidden', 'true')", app_js)
        self.assertIn("newContentBtn.tabIndex = -1", app_js)
        self.assertIn("if (append) scrollOrNotifyNewContent(shouldScroll)", app_js)
        self.assertIn("newContentBtn?.addEventListener('click', () => scrollToBottom())", app_js)
        self.assertIn("messagesEl.addEventListener('scroll'", app_js)
        self.assertIn(".new-content-btn", styles)
        self.assertIn("renderMessage(localUserMsg, true, true)", app_js)

    def test_submit_input_clears_slash_assist_state(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")

        self.assertIn('id="slash-autocomplete" class="slash-autocomplete hidden" role="listbox" aria-label="Slash 指令补全" aria-hidden="true"', index_html)
        self.assertIn('id="input" rows="1" placeholder="输入消息，或输入 /help" aria-label="消息输入框" title="输入消息，或输入 /help" aria-controls="slash-autocomplete" aria-expanded="false"', index_html)
        self.assertIn('aria-controls="slash-autocomplete" aria-expanded="false"', index_html)
        self.assertIn("function setSlashAutocompleteVisible(visible, activeId = '')", app_js)
        self.assertIn("slashAutocompleteEl.setAttribute('aria-hidden', visible ? 'false' : 'true')", app_js)
        self.assertIn("inputEl.setAttribute('aria-expanded', visible ? 'true' : 'false')", app_js)
        self.assertIn("inputEl.setAttribute('aria-activedescendant', activeId)", app_js)
        self.assertIn("inputEl.removeAttribute('aria-activedescendant')", app_js)
        self.assertIn("row.id = `slash-suggestion-${index}`", app_js)
        self.assertIn("const optionLabel = `/${cmd.name}：${cmd.desc}。用法：${cmd.usage}`", app_js)
        self.assertIn("row.setAttribute('aria-label', optionLabel)", app_js)
        self.assertIn("row.title = optionLabel", app_js)
        self.assertIn("setSlashAutocompleteVisible(true, `slash-suggestion-${slashSuggestionIndex}`)", app_js)
        self.assertIn("setSlashAutocompleteVisible(false)", app_js)
        self.assertIn("function clearSlashAssist()", app_js)
        self.assertIn("inputEl.classList.remove('slash-active')", app_js)
        self.assertIn("if (slashAutocompleteEl) slashAutocompleteEl.textContent = ''", app_js)
        self.assertIn("clearSlashAssist()", app_js)

    def test_send_button_title_follows_configured_shortcut(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        index_html = (ROOT / "frontends" / "desktop" / "static" / "index.html").read_text(encoding="utf-8")
        controls_start = app_js.index("function renderComposerControls()")
        controls_end = app_js.index("function reconcileModelSelectionAfterProfiles()", controls_start)
        controls_fn = app_js[controls_start:controls_end]

        self.assertIn('id="send-btn"', index_html)
        self.assertIn('id="send-btn" class="send-btn" type="button"', index_html)
        self.assertIn('aria-label="输入消息或添加文件后发送"', index_html)
        self.assertIn("function sendShortcutLabel()", app_js)
        self.assertIn("composerSendShortcut || 'enter') === 'cmd-enter' ? 'Cmd/Ctrl+Enter' : 'Enter'", app_js)
        self.assertIn("function getSendButtonTitle({ busy, attachmentBusy, hasText, hasAttachments })", app_js)
        self.assertIn("if (busy) return '停止（Esc）'", app_js)
        self.assertIn("if (attachmentBusy) return '正在读取附件…'", app_js)
        self.assertIn("if (!hasText && !hasAttachments) return '输入消息或添加文件后发送'", app_js)
        self.assertIn("return `发送（${sendShortcutLabel()}）`", app_js)
        self.assertIn("const sendTitle = getSendButtonTitle({ busy, attachmentBusy, hasText, hasAttachments })", app_js)
        self.assertIn("sendBtn.setAttribute('aria-label', sendTitle)", app_js)
        self.assertIn("const plainSend = e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && sendShortcut === 'enter'", app_js)
        self.assertIn("renderSendButtonState()", controls_fn)

    def test_composer_model_and_permission_switches_roll_back_on_bridge_failure(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("const previous = sess.config.permissionMode || 'default'", app_js)
        self.assertIn("sess.config.permissionMode = previous", app_js)
        self.assertIn("showError('切换权限模式失败：' + (err.message || err))", app_js)
        self.assertIn("const previous = Math.max(0, parseInt(sess.config.llmNo || '0', 10) || 0)", app_js)
        self.assertIn("sess.config.llmNo = previous", app_js)
        self.assertIn("showError('切换模型失败：' + (err.message || err))", app_js)

    def test_stale_bridge_session_is_recreated_for_model_switch_and_prompt(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        send_fn = js_function_source(app_js, "sendPrompt")
        model_fn = js_function_source(app_js, "setComposerModel")
        poll_fn = js_function_source(app_js, "pollSessionMessages")
        ensure_fn = js_function_source(app_js, "ensureBridgeSession")

        self.assertIn("function isBridgeSessionNotFoundError", app_js)
        self.assertIn("function clearStaleBridgeSession", app_js)
        self.assertIn("function sessionPromptPayload", app_js)
        self.assertIn("async function submitPromptWithSessionRecovery", app_js)
        self.assertIn("if (isBridgeSessionNotFoundError(err))", model_fn)
        self.assertIn("clearStaleBridgeSession(sess, err, attemptedSessionId)", model_fn)
        self.assertIn("result = await bridgeApi.rpc('session/model', { sessionId: await ensureBridgeSession(sess), llmNo })", model_fn)
        self.assertIn("const res = await submitPromptWithSessionRecovery(sess, sessionPromptPayload", send_fn)
        self.assertIn("clearStaleBridgeSession(sess, e)", poll_fn)
        self.assertIn("后端会话已失效，已解除当前等待状态，请重新发送。", poll_fn)
        self.assertIn("const { forceNew = false } = options || {}", ensure_fn)
        self.assertIn("if (!forceNew && sess.bridgeSessionId) return sess.bridgeSessionId", ensure_fn)

    def test_slash_agent_switch_persists_and_rolls_back_on_bridge_failure(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")
        start = app_js.index("async function switchAgentFromComposer")
        end = app_js.index("function showPermissionModeLocation", start)
        fn = app_js[start:end]

        self.assertIn("const previous = Math.max(0, parseInt(sess.config.llmNo || '0', 10) || 0)", fn)
        self.assertIn("await bridgeApi.rpc('session/model'", fn)
        self.assertIn("await persistDesktopConfig(sess.config)", fn)
        self.assertIn("sess.config.llmNo = previous", fn)
        self.assertIn("showError('切换 Agent 失败：' + (err.message || err))", fn)

    def test_bridge_ready_waits_until_desktop_config_is_loaded(self):
        app_js = (ROOT / "frontends" / "desktop" / "static" / "app.js").read_text(encoding="utf-8")

        self.assertIn("configLoaded: false", app_js)
        self.assertIn("pendingBridgeReadyNotice: null", app_js)
        self.assertIn("if (!state.configLoaded)", app_js)
        self.assertIn("state.pendingBridgeReadyNotice = 'Bridge 已就绪。'", app_js)
        self.assertIn("state.configLoaded = true", app_js)
        self.assertIn("markBridgeReady(notice)", app_js)


if __name__ == "__main__":
    unittest.main()
