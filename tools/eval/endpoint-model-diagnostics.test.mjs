import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { startEndpointGateway, validateRoutes } from './endpoint-gateway.mjs';

async function freePort() {
 const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
 const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

test('diagnostics cannot select a host credential or history file', () => {
 const route = { kind: 'model', host: 'localhost', port: 9000, listenPort: 19001, token: 'fixture', paths: ['/v1'] };
 assert.throws(() => validateRoutes([{ ...route, diagnosticPath: '/state/private-auth.json' }]), /gateway-owned/);
 assert.doesNotThrow(() => validateRoutes([{ ...route, diagnosticPath: '/gateway-state/model-requests.jsonl' }]));
});

for (const scenario of ['before_headers', 'during_body', 'diagnostic_callback_throws']) {
 test(`model diagnostics preserve transport behavior and exclude private content: ${scenario}`, async () => {
  const diagnostics = [];
  const upstream = http.createServer(async (request, response) => {
   for await (const _chunk of request) { /* Do not record request content. */ }
   response.writeHead(200, { 'content-type': 'text/event-stream' });
   if (scenario === 'during_body') {
    response.write('data: PRIVATE_RESPONSE_CONTENT\n\n');
    setTimeout(() => response.destroy(), 25);
   } else response.end('data: fixture\n\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamPort = scenario === 'before_headers' ? await freePort() : upstream.address().port;
  const port = await freePort();
  const [gateway] = startEndpointGateway({ bind: '127.0.0.1', routes: [{ kind: 'model', host: '127.0.0.1', port: upstreamPort,
   listenPort: port, token: 'PRIVATE_TOKEN', modelId: 'fixture', paths: ['/v1/chat/completions'] }],
   onModelDiagnostic: event => { diagnostics.push(event); if (scenario === 'diagnostic_callback_throws') throw new Error('diagnostic sink unavailable'); } });
  await once(gateway, 'listening');
  const send = () => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
   method: 'POST', body: JSON.stringify({ model: 'fixture', messages: [{ content: 'PRIVATE_REQUEST_CONTENT' }] }) });
  try {
   if (scenario === 'during_body') {
    await assert.rejects(async () => { const response = await send(); await response.text(); });
    const ended = diagnostics.find(event => event.status === 'upstream_error');
    assert.equal(ended?.phase, 'upstream_body'); assert.equal(ended?.upstreamStatus, 200);
    assert.ok(ended.receivedBytes > 0); assert.ok(ended.causes.length > 0);
   } else {
    const response = await send();
    if (scenario === 'before_headers') {
     assert.equal(response.status, 502); await response.text();
     const ended = diagnostics.find(event => event.status === 'request_error');
     assert.equal(ended?.phase, 'upstream_headers'); assert.equal(ended?.receivedBytes, 0);
     assert.ok(ended.causes.some(cause => cause.code === 'ECONNREFUSED'));
    } else {
     assert.equal(response.status, 200); assert.equal(await response.text(), 'data: fixture\n\n');
     assert.ok(diagnostics.some(event => event.status === 'completed'));
    }
   }
   assert.equal(diagnostics.filter(event => event.status !== 'started').length, 1);
   const serialized = JSON.stringify(diagnostics);
   for (const secret of ['PRIVATE_TOKEN', 'PRIVATE_REQUEST_CONTENT', 'PRIVATE_RESPONSE_CONTENT']) assert.ok(!serialized.includes(secret));
  } finally { await close(gateway); await close(upstream); }
 });
}
