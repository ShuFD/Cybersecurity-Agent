import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRoutes } from './endpoint-gateway.mjs';
import { startEndpointGateway } from './endpoint-gateway.mjs';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

async function availablePort() {
 const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
 const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function closeServer(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
test('scope is an exact host and port pair, not the whole host', () => {
 const management = [{ host: '100.85.231.58', port: 22 }];
 assert.doesNotThrow(() => validateRoutes([{ host: '100.85.231.58', port: 44140, listenPort: 18080 }], management));
 assert.throws(() => validateRoutes([{ host: '100.85.231.58', port: 22, listenPort: 18080 }], management), /Protected/);
 assert.throws(() => validateRoutes([{ host: 'localhost', port: 10, listenPort: 18080 }, { host: 'localhost', port: 11, listenPort: 18080 }]), /duplicate/);
});

test('durable verifier replay preserves spent and ambiguous reservations without re-verifying', async () => {
 const directory = mkdtempSync(join(tmpdir(), 'verifier-ledger-'));
 const journalPath = join(directory, 'verification.jsonl');
 const digest = flag => createHash('sha256').update(flag).digest('hex');
 const identity = { runId: 'run', challengeId: 'synthetic' };
 writeFileSync(journalPath, [
  { ...identity, type: 'reserved', digest: digest('ambiguous') },
  { ...identity, type: 'reserved', digest: digest('settled') },
  { ...identity, type: 'settled', digest: digest('settled'), response: { status: 200, body: { status: 'incorrect' } } },
 ].map(JSON.stringify).join('\n') + '\n');
 let calls = 0;
 const upstream = http.createServer(async (request, response) => {
  for await (const _ of request) { /* drain */ } calls++;
  response.end(JSON.stringify({ status: 'incorrect' }));
 });
 upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
 const port = await availablePort();
 const [gateway] = startEndpointGateway({ bind: '127.0.0.1', routes: [{ kind: 'verifier', host: '127.0.0.1',
  port: upstream.address().port, listenPort: port, ...identity, agentId: 'trusted', token: 'fixture', journalPath }] });
 await once(gateway, 'listening');
 const send = flag => fetch(`http://127.0.0.1:${port}/api/v1/verify`, { method: 'POST', body: JSON.stringify({ flag, run_id: 'run', challenge_id: 'synthetic' }) });
 try {
  const unknown = await send('ambiguous'); assert.equal(unknown.status, 503);
  assert.equal((await unknown.json()).failureCategory, 'ambiguous_inflight_recovery');
  assert.equal((await (await send('settled')).json()).status, 'incorrect');
  assert.equal(calls, 0);
  await send('last'); assert.equal(calls, 1);
  assert.equal((await (await send('fourth')).json()).failureCategory, 'quota_exhausted');
  assert.equal(calls, 1);
  const records = readFileSync(journalPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.filter(item => item.type === 'reserved').length, 3);
 } finally { await closeServer(gateway); await closeServer(upstream); rmSync(directory, { recursive: true }); }
});

test('model gateway fixes provider credentials and model ID while denying other paths', async () => {
 let calls = 0;
 const upstream = http.createServer(async (request, response) => {
  assert.equal(request.headers.authorization, 'Bearer host-only-fixture');
  let body = ''; for await (const chunk of request) body += chunk;
  assert.equal(JSON.parse(body).model, 'same-model'); calls++;
  response.setHeader('content-type', 'text/event-stream'); response.end('data: fixture\n\n');
 });
 upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
 const port = await availablePort();
 const [gateway] = startEndpointGateway({ bind: '127.0.0.1', routes: [{ kind: 'model', host: '127.0.0.1', port: upstream.address().port,
  listenPort: port, token: 'host-only-fixture', modelId: 'same-model', paths: ['/v1/chat/completions'] }] });
 await once(gateway, 'listening');
 const send = (path, model) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { authorization: 'Bearer model-chosen' }, body: JSON.stringify({ model }) });
 try {
  assert.equal((await send('/admin', 'same-model')).status, 403);
  assert.equal((await send('/v1/chat/completions', 'different-model')).status, 403);
  const response = await send('/v1/chat/completions', 'same-model');
  assert.equal(response.status, 200); assert.equal(await response.text(), 'data: fixture\n\n');
  assert.equal(calls, 1);
 } finally { await closeServer(gateway); await closeServer(upstream); }
});
test('verifier gateway binds identity, coalesces requests, rejects history queries and enforces shared quota', async () => {
 let calls = 0;
 const upstream = http.createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const input = JSON.parse(body); calls++;
  assert.equal(input.agent_id, 'trusted-agent');
  response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, status: 'incorrect', verified: false, correct: false }));
 });
 upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
 const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
 const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
 const [gateway] = startEndpointGateway({ bind: '127.0.0.1', routes: [{ kind: 'verifier', host: '127.0.0.1',
  port: upstream.address().port, listenPort: port, challengeId: 'synthetic', runId: 'run', agentId: 'trusted-agent', token: 'fixture-only' }] });
 await once(gateway, 'listening');
 const base = `http://127.0.0.1:${port}`;
 const send = (flag, run_id = 'run') => fetch(`${base}/api/v1/verify`, { method: 'POST', body: JSON.stringify({ challenge_id: 'synthetic', run_id, flag, agent_id: 'model-chosen' }) });
 try {
  assert.equal((await fetch(`${base}/api/v1/attempts`)).status, 403);
  assert.equal((await send('ignored', 'another-run')).status, 403);
  await Promise.all([send('one'), send('one')]); assert.equal(calls, 1);
  await Promise.all([send('two'), send('three')]); assert.equal(calls, 3);
  assert.equal((await (await send('four')).json()).status, 'limit_exceeded'); assert.equal(calls, 3);
 } finally {
  gateway.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
 }
});
