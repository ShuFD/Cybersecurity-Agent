import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapSandbox } from './sandbox-bootstrap.mjs';
function docker(args) {
 const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
 if (result.status !== 0) throw new Error(`Docker ${args[0]}: ${result.stderr.slice(0, 2000)}`);
 return result.stdout.trim();
}
const image = process.argv[2];
if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new Error('Pass the exact locally built image ID');
const runId = `synthetic-boundary-${randomUUID()}`;
const root = join('/home/seu/secheur-eval-acceptance-20261013', runId);
mkdirSync(join(root, 'attachments'), { recursive: true }); mkdirSync(join(root, 'model-config'));
writeFileSync(join(root, 'attachments', 'fixture.txt'), 'current-question-only');
const toolchain = docker(['run', '--rm', '--network', 'none', '--entrypoint', 'cat', image, '/opt/toolchain.json']);
const toolchainDigest = createHash('sha256').update(toolchain).digest('hex');
// The file has no final newline; Docker helper trims stdout without changing the JSON bytes.
const manifest = { runId, challengeId: 'synthetic/host-boundary', image, toolchainDigest,
 attachments: join(root, 'attachments'), modelConfig: join(root, 'model-config'),
 endpoints: [{ host: '127.0.0.1', port: 19099, transport: 'tcp' }],
 protectedEndpoints: [{ host: '100.85.231.58', port: 22, transport: 'tcp' }] };
let sandbox;
try {
 sandbox = bootstrapSandbox(manifest, [{ host: '127.0.0.1', port: 19099, listenPort: 18080 }]);
 docker(['exec', '--detach', sandbox.gateway, 'node', '-e', "require('node:net').createServer(s=>s.end('gateway-fixture')).listen(19099,'127.0.0.1')"]);
 const probe = `
  const fs=require('node:fs'),net=require('node:net'),assert=require('node:assert/strict');
  assert.equal(process.getuid(),1000); assert.equal(fs.readFileSync('/attachments/fixture.txt','utf8'),'current-question-only');
  for(const path of ['/tmp/sop_work','/home/shared/eval-runner','/var/run/docker.sock']) assert.equal(fs.existsSync(path),false);
  assert.throws(()=>fs.writeFileSync('/attachments/fixture.txt','changed'));
  fs.writeFileSync('/workspace/current-artifact','this-run'); fs.writeFileSync('/state/run-ledger.json',JSON.stringify({runId:${JSON.stringify(runId)}}));
  assert.match(fs.readFileSync('/proc/self/status','utf8'),/CapEff:\\s+0000000000000000/);
  function request(host,port) {return new Promise(resolve=>{const s=net.connect({host,port});let text='';s.setTimeout(1500);s.on('data',b=>text+=b);s.on('end',()=>resolve({connected:true,text}));s.on('error',e=>resolve({connected:false,code:e.code}));s.on('timeout',()=>{s.destroy();resolve({connected:false,code:'timeout'});});});}
  (async()=>{ const allowed=await request(${JSON.stringify(sandbox.gatewayAddress)},18080);assert.equal(allowed.text,'gateway-fixture');
   const denied=await request('100.85.231.58',22);assert.equal(denied.connected,false);
   const outside=await request(${JSON.stringify(sandbox.gatewayAddress)},18082);assert.equal(outside.connected,false);
   console.log(JSON.stringify({status:'passed',isolatedAttachments:true,historyAbsent:true,readOnlyInputs:true,zeroCapabilities:true,allowedGateway:true,hostSshBlocked:true,unlistedPortBlocked:true,privateLedger:true}));
  })().catch(e=>{console.error(e.message);process.exitCode=1;});`;
 const observed = JSON.parse(docker(['exec', sandbox.worker, 'node', '-e', probe]));
 assert.equal(observed.status, 'passed');
 const report = { ...observed, runId, image, toolchainDigest, fixtureOnly: true, hostNetworkConfigurationChanged: false };
 writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally {
 if (sandbox) {
  docker(['rm', '-f', sandbox.worker]); docker(['rm', '-f', sandbox.gateway]);
  docker(['network', 'rm', sandbox.network]); docker(['network', 'rm', sandbox.egress]);
 }
}
