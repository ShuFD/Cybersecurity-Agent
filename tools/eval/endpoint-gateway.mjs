import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFileSync, writeSync, openSync, fsyncSync, closeSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function verifierSocketRequest(socketPath, payload) {
 return new Promise((resolve, reject) => {
  const socket = net.connect(socketPath); let data = Buffer.alloc(0); let done = false;
  const finish = (error, value) => { if (done) return; done = true; socket.destroy(); error ? reject(error) : resolve({ status: 200, body: value }); };
  socket.setTimeout(8000, () => finish(new Error('Verifier request timeout')));
  socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
  socket.on('data', chunk => {
   data = Buffer.concat([data, chunk]); if (data.length > 1000000) { finish(new Error('Verifier response too large')); return; }
   const newline = data.indexOf(10);
   if (newline >= 0) { try { finish(null, JSON.parse(data.subarray(0, newline).toString('utf8'))); } catch (error) { finish(error); } }
  });
  socket.on('error', finish); socket.on('close', () => { if (!done) finish(new Error('Verifier closed before complete response')); });
 });
}

// A trusted controller writes this immutable manifest. No request chooses a destination.
export function validateRoutes(routes, protectedEndpoints = []) {
 const ports = new Set();
 for (const route of routes) {
	if (route.kind && !['tcp', 'verifier', 'model'].includes(route.kind)) throw new Error('Unknown gateway route kind');
  if (!Number.isInteger(route.listenPort) || route.listenPort < 1024 || route.listenPort > 65535 || ports.has(route.listenPort))
   throw new Error('Invalid or duplicate gateway listener');
  if (!Number.isInteger(route.port) || route.port < 1 || route.port > 65535 || !/^[a-zA-Z0-9:._-]+$/.test(route.host))
   throw new Error('Invalid gateway destination');
  if (protectedEndpoints.some(endpoint => endpoint.host.toLowerCase() === route.host.toLowerCase() && endpoint.port === route.port))
   throw new Error('Protected management destination');
  ports.add(route.listenPort);
  if (route.kind === 'verifier' && (!route.challengeId || !route.runId || (!route.token && !route.socketPath) || !route.agentId))
   throw new Error('Verifier requires a trusted run identity and credential');
  if (route.kind === 'model' && (!route.token || !Array.isArray(route.paths) || route.paths.length === 0 || route.paths.some(path => !/^\/[A-Za-z0-9_/-]+$/.test(path))))
   throw new Error('Model gateway requires fixed API paths and a controller-owned credential');
  if (route.kind === 'model' && route.diagnosticPath && route.diagnosticPath !== '/gateway-state/model-requests.jsonl')
   throw new Error('Model diagnostics require the gateway-owned journal path');
 }
}
export function startEndpointGateway({ bind, routes, protectedEndpoints = [], onModelDiagnostic }) {
 validateRoutes(routes, protectedEndpoints);
 if (!net.isIP(bind) || bind === '0.0.0.0' || bind === '::') throw new Error('Gateway must bind only its private run interface');
 let modelRequestSequence = 0;
 return routes.map(route => {
  if (route.kind === 'model') {
   const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || !route.paths.includes(request.url)) { response.writeHead(403); response.end(); return; }
    const startedAt = Date.now(); const requestId = `model-${++modelRequestSequence}`;
    let phase = 'request_body'; let receivedBytes = 0; let upstreamStatus; let settled = false;
    const emit = (status, error) => {
     if (settled) return;
     if (status !== 'started') settled = true;
     const causes = []; let cause = error;
     for (let depth = 0; cause && depth < 4; depth++, cause = cause.cause) {
      const safe = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/.test(value) ? value : undefined;
      causes.push({ name: safe(cause.name), code: safe(cause.code) });
     }
     try {
      const event = { event: 'model_gateway_request', requestId, status, phase, at: Date.now(), elapsedMs: Date.now() - startedAt, receivedBytes, upstreamStatus, causes };
      if (onModelDiagnostic) onModelDiagnostic(event);
      else if (route.diagnosticPath) {
       const descriptor = openSync(route.diagnosticPath, 'a', 0o600);
       try { writeSync(descriptor, JSON.stringify(event) + '\n'); } finally { closeSync(descriptor); }
      } else console.error(JSON.stringify(event));
     }
     catch { /* Diagnostics must not affect transport or executor lifetimes. */ }
    };
    try {
     const chunks = []; let size = 0;
     for await (const chunk of request) { size += chunk.length; if (size > 16 * 1024 * 1024) { response.writeHead(413); response.end(); return; } chunks.push(chunk); }
     const body = Buffer.concat(chunks);
     if (route.modelId && JSON.parse(body.toString('utf8')).model !== route.modelId) { response.writeHead(403); response.end(); return; }
     const controller = new AbortController();
     phase = 'upstream_headers'; emit('started');
     response.on('finish', () => emit('completed'));
     response.on('close', () => { if (!response.writableFinished) { emit('client_disconnected'); controller.abort(); } });
     const upstream = await fetch(`${route.protocol === 'https' ? 'https' : 'http'}://${route.host}:${route.port}${request.url}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${route.token}` }, body: Buffer.concat(chunks), redirect: 'error',
      signal: controller.signal,
     });
     upstreamStatus = upstream.status; phase = 'upstream_body';
     response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
     if (upstream.body) {
      const stream = Readable.fromWeb(upstream.body);
      stream.on('data', chunk => { receivedBytes += chunk.length; });
      stream.on('error', error => { emit('upstream_error', error); controller.abort(); response.destroy(); });
      stream.pipe(response);
     } else response.end();
    } catch (error) { emit('request_error', error); if (!response.headersSent) response.writeHead(502); response.end(); }
   });
   server.listen(route.listenPort, bind); return server;
  }
  if (route.kind === 'verifier') {
   const candidates = new Map();
   let attempts = 0;
   const journal = route.journalPath;
   if (journal) {
    mkdirSync(dirname(journal), { recursive: true, mode: 0o700 });
    if (existsSync(journal)) for (const line of readFileSync(journal, 'utf8').split('\n').filter(Boolean)) {
     const item = JSON.parse(line);
     if (item.runId !== route.runId || item.challengeId !== route.challengeId) throw new Error('Gateway ledger ownership mismatch');
     if (item.type === 'reserved') { attempts++; candidates.set(item.digest, Promise.resolve({ status: 503, body: { status: 'unavailable', failureCategory: 'ambiguous_inflight_recovery' } })); }
     if (item.type === 'settled') candidates.set(item.digest, Promise.resolve(item.response));
    }
   }
   const record = item => {
    if (!journal) return;
    const descriptor = openSync(journal, 'a', 0o600);
    try {
     writeSync(descriptor, JSON.stringify({ runId: route.runId, challengeId: route.challengeId, ...item }) + '\n');
     fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
   };
   const server = http.createServer(async (request, response) => {
    const reply = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.method !== 'POST' || request.url !== '/api/v1/verify') { reply(403, { status: 'out_of_scope' }); return; }
    try {
     const chunks = []; let size = 0;
     for await (const chunk of request) { size += chunk.length; if (size > 65536) { reply(413, { status: 'invalid_request' }); return; } chunks.push(chunk); }
     const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
     if (input.challenge_id !== route.challengeId || input.run_id !== route.runId || typeof input.flag !== 'string') {
      reply(403, { status: 'identity_conflict' }); return;
     }
     const digest = createHash('sha256').update(input.flag).digest('hex');
     let pending = candidates.get(digest);
     if (!pending) {
      if (attempts >= 3) { reply(200, { ok: false, status: 'limit_exceeded', failureCategory: 'quota_exhausted' }); return; }
      record({ type: 'reserved', digest });
      attempts++;
      const payload = { flag: input.flag, challenge_id: route.challengeId, run_id: route.runId, agent_id: route.agentId };
      pending = (route.socketPath ? verifierSocketRequest(route.socketPath, payload) : fetch(`${route.protocol === 'https' ? 'https' : 'http'}://${route.host}:${route.port}/api/v1/verify`, {
       method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${route.token}` }, redirect: 'error',
       body: JSON.stringify(payload),
      }).then(async upstream => ({ status: upstream.status, body: await upstream.json() })))
       .catch(() => ({ status: 503, body: { status: 'transport_error' } }))
       .then(response => { record({ type: 'settled', digest, response }); return response; });
      candidates.set(digest, pending);
     }
     const upstream = await pending; reply(upstream.status, upstream.body);
    } catch (error) { reply(error instanceof SyntaxError ? 400 : 503, { status: error instanceof SyntaxError ? 'invalid_request' : 'gateway_unavailable' }); }
   });
   server.listen(route.listenPort, bind); return server;
  }
  const server = net.createServer(client => {
   const upstream = net.connect({ host: route.host, port: route.port });
   client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
   client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
   client.pipe(upstream); upstream.pipe(client);
  });
  server.listen(route.listenPort, bind);
  return server;
 });
}
if (process.argv[1]?.endsWith('endpoint-gateway.mjs') && process.argv[2]) {
 const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
 startEndpointGateway(manifest);
}
