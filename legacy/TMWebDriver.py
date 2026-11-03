import asyncio, json, threading, time, uuid, queue, socket, requests, traceback
from typing import Any
from simple_websocket_server import WebSocketServer, WebSocket
import bottle
from bottle import request

class Session:
    def __init__(self, session_id, info, client=None):
        self.id = session_id
        self.info = info
        self.connect_at = time.time()
        self.disconnect_at = None
        self.type = info.get('type', 'ws')
        self.ws_client = client if self.type in ('ws', 'ext_ws') else None
        self.http_queue = client if self.type == 'http' else None
    @property
    def url(self): return self.info.get('url', '')
    def is_active(self):
        if self.type == 'http' and time.time() - self.connect_at > 60: self.mark_disconnected()
        return self.disconnect_at is None
    def reconnect(self, client, info):
        self.info = info
        self.type = info.get('type', 'ws')
        if self.type in ('ws', 'ext_ws'):
            self.ws_client = client
            self.http_queue = None
        elif self.type == 'http':
            self.http_queue = client
        self.connect_at = time.time()
        self.disconnect_at = None
    def mark_disconnected(self):
        if self.is_active(): print(f"Tab disconnected: {self.url} (Session: {self.id})")
        self.disconnect_at = time.time()


class TMWebDriver:  
    def __init__(self, host: str = '127.0.0.1', port: int = 18765):  
        self.host, self.port = host, port
        self.sessions, self.results, self.acks = {}, {}, {}
        self.lock = threading.RLock()
        self.default_session_id = None  
        self.latest_session_id = None  
        self.cdp_port = 9222
        self.ext_ws_clients = set()
        self.last_ext_event_at = None
        self.last_ext_message_type = None
        self.last_ext_disconnect_at = None
        self.last_all_tabs = []
        self.last_scriptable_tabs = []
        self.is_remote = socket.socket().connect_ex((host, port+1)) == 0
        if not self.is_remote:  
            self.start_ws_server()  
            self.start_http_server()
        else:
            self.remote = f'http://{self.host}:{self.port+1}/link'

    def start_http_server(self):
        self.app = app = bottle.Bottle()

        @app.route('/api/longpoll', method=['GET', 'POST'])
        def long_poll():
            data = request.json
            session_id = data.get('sessionId')  
            session_info = {'url': data.get('url'), 'title': data.get('title', ''), 'type': 'http'}  
            if session_id not in self.sessions: 
                session = Session(session_id, session_info, queue.Queue())
                print(f"Browser http connected: {session.url} (Session: {session_id})")  
                self.sessions[session_id] = session
            session = self.sessions[session_id]
            if session.disconnect_at is not None and session.type != 'http': session.reconnect(queue.Queue(), session_info)
            session.disconnect_at = None
            if session.type == 'http': msgQ = session.http_queue
            else: return json.dumps({"id": "", "ret": "use ws"})
            session.connect_at = start_time = time.time()
            while time.time() - start_time < 5:
                try:
                    msg = msgQ.get(timeout=0.2)
                    try: self.acks[json.loads(msg).get('id','')] = True
                    except Exception: traceback.print_exc()
                    return msg
                except queue.Empty: continue
            return json.dumps({"id": "", "ret": "next long-poll"})

        @app.route('/api/result', method=['GET','POST'])
        def result():
            data = request.json
            if data.get('type') == 'result':  
                self.results[data.get('id')] = {'success': True, 'data': data.get('result'), 'newTabs': data.get('newTabs', [])}  
            elif data.get('type') == 'error':  
                self.results[data.get('id')] = {'success': False, 'data': data.get('error'), 'newTabs': data.get('newTabs', [])}  
            return 'ok'

        @app.route('/health', method=['GET'])
        def health():
            return json.dumps({'ok': True, 'status': self.get_status()}, ensure_ascii=False)

        @app.route('/link', method=['GET','POST'])
        def link():
            data = request.json
            if data.get('cmd') == 'get_all_sessions': return json.dumps({'r': self.get_all_sessions()}, ensure_ascii=False)  
            if data.get('cmd') == 'get_status': return json.dumps({'r': self.get_status()}, ensure_ascii=False)
            if data.get('cmd') == 'get_cdp_sessions': return json.dumps({'r': self.get_cdp_sessions()}, ensure_ascii=False)
            if data.get('cmd') == 'find_session': 
                url_pattern = data.get('url_pattern', '')
                return json.dumps({'r': self.find_session(url_pattern)}, ensure_ascii=False)
            if data.get('cmd') == 'execute_js':
                session_id = data.get('sessionId')
                code = data.get('code')
                timeout = float(data.get('timeout', 10.0))
                try:
                    result = self.execute_js(code, timeout=timeout, session_id=session_id)
                    print('[remote result]', (str(code)[:50] + ' RESULT:' +str(result)[:50]).replace('\n', ' '))
                    return json.dumps({'r': result}, ensure_ascii=False)
                except Exception as e:
                    return json.dumps({'r': {'error': str(e)}}, ensure_ascii=False)
            if data.get('cmd') == 'execute_cdp_js':
                session_id = data.get('sessionId')
                code = data.get('code')
                timeout = float(data.get('timeout', 10.0))
                try:
                    result = self.execute_cdp_js(code, timeout=timeout, session_id=session_id)
                    return json.dumps({'r': result}, ensure_ascii=False)
                except Exception as e:
                    return json.dumps({'r': {'error': str(e)}}, ensure_ascii=False)
            return 'ok'
        def run():
            from wsgiref.simple_server import make_server, WSGIServer, WSGIRequestHandler
            from socketserver import ThreadingMixIn
            class _T(ThreadingMixIn, WSGIServer): pass
            class _H(WSGIRequestHandler):
                def log_request(self, *a): pass
            make_server(self.host, self.port+1, app, server_class=_T, handler_class=_H).serve_forever()
        http_thread = threading.Thread(target=run, daemon=True)
        http_thread.start()  

    def clean_sessions(self):
        with self.lock:
            sids = list(self.sessions.keys())
            for sid in sids:
                session = self.sessions[sid]
                if not session.is_active() and time.time() - session.disconnect_at > 600:
                    del self.sessions[sid]
    
    def start_ws_server(self) -> None:  
        driver = self  
        class JSExecutor(WebSocket):  
            def handle(self) -> None:  
                try:  
                    data = json.loads(self.data)  
                    if data.get('type') == 'ready':  
                        session_id = data.get('sessionId')  
                        session_info = {'url': data.get('url'), 'title': data.get('title', ''),
                            'connected_at': time.time(), 'type': 'ws'}  
                        driver._register_client(session_id, self, session_info)  
                    elif data.get('type') in ['ext_ready', 'tabs_update']:
                        tabs = data.get('tabs', [])
                        now = time.time()
                        current_tab_ids = {str(tab['id']) for tab in tabs}
                        print(f"Received tabs update: {current_tab_ids}")
                        with driver.lock:
                            driver.ext_ws_clients.add(self)
                            driver.last_ext_event_at = now
                            driver.last_ext_message_type = data.get('type')
                            driver.last_all_tabs = data.get('allTabs', tabs) or []
                            driver.last_scriptable_tabs = tabs
                            for sid in list(driver.sessions.keys()):
                                sess = driver.sessions[sid]
                                if sess.type == 'ext_ws' and sid not in current_tab_ids:
                                    sess.mark_disconnected()
                        for tab in tabs:
                            session_id = str(tab['id'])
                            session_info = {'url': tab.get('url'), 'title': tab.get('title', ''), 'connected_at': now, 'type': 'ext_ws'}
                            driver._register_client(session_id, self, session_info)
                    elif data.get('type') == 'ping':
                        driver.last_ext_event_at = time.time()
                    elif data.get('type') == 'ack': driver.acks[data.get('id','')] = True
                    elif data.get('type') == 'result':  
                        driver.results[data.get('id')] = {'success': True, 'data': data.get('result'), 'newTabs': data.get('newTabs', [])}  
                    elif data.get('type') == 'error':  
                        driver.results[data.get('id')] = {'success': False, 'data': data.get('error'), 'newTabs': data.get('newTabs', [])}  
                except Exception as e:  
                    print(f"Error handling message: {e}")  
                    if hasattr(self, 'data'): print(self.data)  
            def connected(self): (f"New connection from {self.address}")  
            def handle_close(self): 
                print(f"WS Connection closed: {self.address}")
                driver._unregister_client(self)  
        
        self.server = WebSocketServer(self.host, self.port, JSExecutor)  
        server_thread = threading.Thread(target=self.server.serve_forever)  
        server_thread.daemon = True  
        server_thread.start()  
        print(f"WebSocket server running on ws://{self.host}:{self.port}")  
    
    def _register_client(self, session_id: str, client: WebSocket, session_info) -> None:  
        with self.lock:
            is_new_session = session_id not in self.sessions

            if is_new_session:
                session = Session(session_id, session_info, client)
                self.sessions[session_id] = session            
                print(f"New tab connected: {session.url} (Session: {session_id})")  
            else:
                session = self.sessions[session_id]
                session.reconnect(client, session_info)
                print(f"Tab reconnected: {session.url} (Session: {session_id})")  

            self.latest_session_id = session_id
            if self.default_session_id is None or self.default_session_id not in self.sessions:
                self.default_session_id = session_id 
    
    def _unregister_client(self, client: WebSocket) -> None:  
        with self.lock:
            self.ext_ws_clients.discard(client)
            self.last_ext_disconnect_at = time.time()
            for session in self.sessions.values():
                if session.ws_client == client: session.mark_disconnected()

    def _cdp_list_url(self):
        return f"http://{self.host}:{self.cdp_port}/json/list"

    def get_cdp_targets(self, timeout=1.0):
        try:
            resp = requests.get(self._cdp_list_url(), timeout=timeout)
            data = resp.json()
        except Exception:
            return []
        if not isinstance(data, list):
            return []
        return [
            target for target in data
            if target.get('type') == 'page' and target.get('webSocketDebuggerUrl')
        ]

    def get_cdp_sessions(self):
        if self.is_remote:
            return self._remote_cmd({"cmd": "get_cdp_sessions"}).get('r', [])
        sessions = []
        for target in self.get_cdp_targets():
            target_id = str(target.get('id') or '')
            if not target_id:
                continue
            sessions.append({
                'id': f"cdp:{target_id}",
                'url': target.get('url', ''),
                'title': target.get('title', ''),
                'type': 'cdp',
            })
        return sessions

    def _select_cdp_target(self, session_id=None):
        targets = self.get_cdp_targets()
        if not targets:
            return None
        wanted = str(session_id or self.default_session_id or '')
        if wanted.startswith('cdp:'):
            wanted = wanted[4:]
        if wanted:
            for target in targets:
                if str(target.get('id') or '') == wanted:
                    return target
        for target in targets:
            if str(target.get('url') or '').startswith(('http://', 'https://')):
                return target
        return targets[0]

    async def _execute_cdp_js_async(self, websocket_url, code, timeout):
        from aiohttp import ClientSession, ClientTimeout, WSMsgType
        expression = f"(async function() {{\n{code}\n}})()"
        payload = {
            'id': 1,
            'method': 'Runtime.evaluate',
            'params': {
                'expression': expression,
                'awaitPromise': True,
                'returnByValue': True,
                'timeout': int(max(timeout, 1) * 1000),
            },
        }
        async with ClientSession(timeout=ClientTimeout(total=timeout + 3)) as client:
            async with client.ws_connect(websocket_url, timeout=timeout) as ws:
                await ws.send_str(json.dumps(payload))
                deadline = time.time() + timeout
                while time.time() < deadline:
                    msg = await ws.receive(timeout=max(0.1, min(1.0, deadline - time.time())))
                    if msg.type == WSMsgType.TEXT:
                        data = json.loads(msg.data)
                        if data.get('id') != 1:
                            continue
                        result = data.get('result') or {}
                        if result.get('exceptionDetails'):
                            exc = result['exceptionDetails']
                            detail = exc.get('text') or exc.get('exception', {}).get('description') or str(exc)
                            raise Exception(detail)
                        remote = result.get('result') or {}
                        if 'value' in remote:
                            return remote.get('value')
                        return remote.get('description')
                    if msg.type in (WSMsgType.CLOSED, WSMsgType.CLOSE, WSMsgType.ERROR):
                        break
        raise TimeoutError(f"CDP Runtime.evaluate timed out after {timeout}s")

    def execute_cdp_js(self, code, timeout=15, session_id=None):
        if self.is_remote:
            response = self._remote_cmd({"cmd": "execute_cdp_js", "sessionId": session_id,
                                         "code": code, "timeout": str(timeout)}).get('r', {})
            if response.get('error'): raise Exception(response['error'])
            return response
        target = self._select_cdp_target(session_id)
        if not target:
            raise ConnectionError(f"No CDP page targets from {self._cdp_list_url()}")
        cdp_session_id = f"cdp:{target.get('id')}"
        self.default_session_id = cdp_session_id
        self.latest_session_id = cdp_session_id
        value = asyncio.run(self._execute_cdp_js_async(target['webSocketDebuggerUrl'], code, timeout))
        return {'data': value}

    def get_status(self):
        if self.is_remote:
            return self._remote_cmd({"cmd": "get_status"}).get('r', {})
        sessions = self.get_all_sessions()
        cdp_targets = self.get_cdp_targets(timeout=0.5)
        now = time.time()
        with self.lock:
            default_session = self.sessions.get(self.default_session_id)
            default_active = bool(default_session and default_session.is_active())
            ext_connected = bool(self.ext_ws_clients)
            all_tabs = list(self.last_all_tabs or [])
            scriptable_tabs = list(self.last_scriptable_tabs or [])
            last_ext_event_at = self.last_ext_event_at
            last_ext_disconnect_at = self.last_ext_disconnect_at
            last_ext_message_type = self.last_ext_message_type
        if sessions:
            reason = 'ok'
        elif all_tabs and not scriptable_tabs:
            reason = 'no_scriptable_tabs'
        elif cdp_targets:
            reason = 'extension_no_sessions_cdp_available'
        elif not ext_connected:
            reason = 'extension_disconnected'
        else:
            reason = 'no_browser_sessions'
        return {
            'ok': bool(sessions),
            'reason': reason,
            'host': self.host,
            'ws_port': self.port,
            'http_port': self.port + 1,
            'default_session_id': self.default_session_id,
            'default_session_active': default_active,
            'latest_session_id': self.latest_session_id,
            'sessions_count': len(sessions),
            'sessions': sessions,
            'extension': {
                'connected': ext_connected,
                'last_event_age_sec': round(now - last_ext_event_at, 2) if last_ext_event_at else None,
                'last_disconnect_age_sec': round(now - last_ext_disconnect_at, 2) if last_ext_disconnect_at else None,
                'last_message_type': last_ext_message_type,
                'all_tabs_count': len(all_tabs),
                'scriptable_tabs_count': len(scriptable_tabs),
                'all_tabs_sample': all_tabs[:5],
            },
            'cdp': {
                'available': bool(cdp_targets),
                'port': self.cdp_port,
                'targets_count': len(cdp_targets),
                'sessions': self.get_cdp_sessions(),
            },
        }
    
    def execute_js(self, code, timeout=15, session_id=None) -> Any:  
        if session_id is None: session_id = self.default_session_id  
        if self.is_remote:
            print('remote_execute_js')
            response = self._remote_cmd({"cmd": "execute_js", "sessionId": session_id, 
                                         "code": code, "timeout": str(timeout)}).get('r', {})
            if response.get('error'): raise Exception(response['error'])
            return response
        if str(session_id or '').startswith('cdp:'):
            return self.execute_cdp_js(code, timeout=timeout, session_id=session_id)
 
        session = self.sessions.get(session_id)
        if not session or not session.is_active(): 
            time.sleep(3)
            session = self.sessions.get(session_id)
            if not session or not session.is_active(): 
                alive_sessions = [s for s in self.sessions.values() if s.is_active()]
                if alive_sessions:
                    session = alive_sessions[0]  
                    print(f"会话 {session_id} 未连接，自动切换到最新活动会话: {session.id}")
                    session_id = self.default_session_id = session.id
                if not session or not session.is_active(): 
                    if self.get_cdp_targets(timeout=0.5):
                        return self.execute_cdp_js(code, timeout=timeout, session_id=session_id)
                    raise ValueError(f"会话ID {session_id} 未连接")  

        tp = session.type
        if tp not in ('ws', 'http', 'ext_ws'):
            raise ValueError(f"Unsupported session type: {tp}")
        exec_id = str(uuid.uuid4())  
        payload_dict = {'id': exec_id, 'code': code}
        if tp == 'ext_ws': payload_dict['tabId'] = int(session.id)
        payload = json.dumps(payload_dict)

        if tp in ['ws', 'ext_ws']: session.ws_client.send_message(payload)  
        elif tp == 'http': session.http_queue.put(payload)

        start_time = time.time()  
        self.clean_sessions() 
        hasjump = acked = False

        while exec_id not in self.results:  
            time.sleep(0.2)  
            if not acked and exec_id in self.acks:
                acked = True; start_time = time.time()
            if tp in ['ws', 'ext_ws']:
                if not session.is_active(): hasjump = True
                if hasjump and session.is_active():
                    return {'result': f"Session {session_id} reloaded.", "closed":1}
            if time.time() - start_time > timeout:  
                if tp in ['ws', 'ext_ws']:
                    if hasjump: return {'result': f"Session {session_id} reloaded and new page is loading...", 'closed':1}
                    if acked: return {"result": f"No response data in {timeout}s (ACK received, script may still be running)"}
                    return {"result": f"No response data in {timeout}s (no ACK, script may not have been delivered)"}
                elif tp == 'http':
                    if acked: return {"result": f"Session {session_id} no response in {timeout}s (delivered but no result)"}
                    return {"result": f"Session {session_id} no response in {timeout}s (script not polled)"}
        
        result = self.results.pop(exec_id)  
        if exec_id in self.acks: self.acks.pop(exec_id)
        if not result['success']: raise Exception(result['data'])  
        rr = {'data': result['data']}
        newtabs = result.get('newTabs', []); [x.pop('ts', None) for x in newtabs]
        if newtabs: rr['newTabs'] = newtabs
        return rr
    
    def _remote_cmd(self, cmd):
        try: return requests.post(self.remote, headers={"Content-Type": "application/json"}, json=cmd, timeout=30).json()
        except (ConnectionError, requests.exceptions.ConnectionError):
            raise ConnectionError("TMWebDriver master未运行，看tmwebdriver_sop启动master")

    def get_all_sessions(self):  
        if self.is_remote:
            return self._remote_cmd({"cmd": "get_all_sessions"}).get('r', [])
        with self.lock:
            return [{'id': session.id, **session.info} for session in self.sessions.values()
                    if session.is_active()]  

    def get_session_dict(self):
        return {session['id']: session['url'] for session in self.get_all_sessions()}
        
    def find_session(self, url_pattern: str):
        if url_pattern == '': 
            session = self.sessions.get(self.latest_session_id)
            return [(session.id, session.info)] if session else []
        matching_sessions = []  
        for session in self.sessions.values():
            if not session.is_active(): continue
            if 'url' in session.info and url_pattern in session.info['url']:  
                matching_sessions.append((session.id, session.info))  
        return matching_sessions

    def set_session(self, url_pattern: str) -> bool:  
        if self.is_remote:
            matched = self._remote_cmd({"cmd": "find_session", "url_pattern": url_pattern}).get('r', [])
        else:
            matched = self.find_session(url_pattern)
        if not matched: return print(f"警告: 未找到URL包含 '{url_pattern}' 的会话")  
        if len(matched) > 1: print(f"警告: 找到多个URL包含 '{url_pattern}' 的会话，选择第一个")  
        self.default_session_id, info = matched[0]
        print(f"成功设置默认会话: {self.default_session_id}: {info['url']}")  
        return self.default_session_id  
    
    def jump(self, url, timeout=10): self.execute_js(f"window.location.href='{url}'", timeout=timeout)
    
if __name__ == "__main__":
    driver = TMWebDriver(host='127.0.0.1', port=18765)
