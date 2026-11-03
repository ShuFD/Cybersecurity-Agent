import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapSandbox } from './sandbox-bootstrap.mjs';

function docker(args) {
 const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
 if (result.status !== 0) throw new Error(`Sandbox Docker ${args[0]} failed: ${result.stderr.slice(0, 2000)}`);
 return result.stdout.trim();
}
export function workerDesktopConfiguration(desktopConfig, mode) {
 if (!['direct', 'progressive', 'cairn', 'hypothesis', 'artex'].includes(mode)) throw new Error('Unknown evaluation mode');
 const planning = { ...(desktopConfig?.planning ?? {}), observerMode: 'off', taskGranularityPromptEnabled: false,
  evidenceCatalogEnabled: desktopConfig?.planning?.evidenceCatalogEnabled ?? desktopConfig?.planning?.evidence_catalog_enabled ?? true,
  mode: mode === 'direct' ? 'off' : 'active',
  engine: mode === 'direct' ? 'progressive' : mode,
  executionMode: { mode: mode === 'direct' ? 'direct' : 'plan_multi', capacity: mode === 'direct' ? 1 : 2 } };
 delete planning.globalExecutorCapacity; delete planning.global_executor_capacity;
 return { ...desktopConfig, maxTurns: 220, memoryReferenceEnabled: false,
  executionMode: planning.executionMode, executionCapacity: planning.executionMode.capacity, planning };
}
export function startSandboxWorker(configuration) {
 const { manifest, routes, desktopConfig } = configuration;
 const effectiveConfiguration = workerDesktopConfiguration(desktopConfig, configuration.mode);
 const modelPath = join(manifest.modelConfig, 'models.json');
 const models = JSON.parse(readFileSync(modelPath, 'utf8'));
 const auth = JSON.parse(readFileSync(join(manifest.modelConfig, 'auth.json'), 'utf8'));
 if (Object.values(models.providers).some(provider => provider.apiKey !== 'eval-gateway-only' || provider.headers) ||
     Object.values(auth).some(credential => credential.type !== 'api_key' || credential.key !== 'eval-gateway-only'))
  throw new Error('Worker configuration must contain only dummy gateway credentials');
 if (Object.keys(JSON.parse(readFileSync(join(manifest.modelConfig, 'settings.json'), 'utf8'))).length)
  throw new Error('Clean worker settings must not import host extensions or history');
 for (const filename of readdirSync(manifest.modelConfig)) if (!['models.json', 'auth.json', 'settings.json'].includes(filename) || !lstatSync(join(manifest.modelConfig, filename)).isFile())
  throw new Error('Worker configuration contains an unexpected file or history directory');
 const sandbox = bootstrapSandbox(manifest, routes);
 try {
  for (const provider of Object.values(models.providers)) {
   const route = routes.find(item => item.kind === 'model' && item.provider === provider.gatewayProvider);
   if (!route) throw new Error('Missing fixed model route');
   if (provider.models.some(model => model.id !== route.modelId)) throw new Error('Worker model differs from controller manifest');
   provider.baseUrl = `http://${sandbox.gatewayAddress}:${route.listenPort}${provider.gatewayBasePath ?? '/v1'}`;
   delete provider.gatewayProvider; delete provider.gatewayBasePath;
  }
  writeFileSync(modelPath, JSON.stringify(models), { mode: 0o644 });
  const configurationSha256 = createHash('sha256').update(JSON.stringify(effectiveConfiguration)).digest('hex');
  const initialize = `const fs=require('node:fs'),crypto=require('node:crypto');for(const item of ${JSON.stringify(manifest.attachmentManifest ?? [])}) {const p='/attachments/'+item.path;if(!fs.statSync(p).isFile()||crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')!==item.sha256)throw Error('sandbox_environment_mismatch: attachment '+item.path);}fs.mkdirSync('/state/pi',{recursive:true});for(const name of ['models.json','auth.json','settings.json']) fs.copyFileSync('/model-config/'+name,'/state/pi/'+name);fs.writeFileSync('/state/desktop-config.json',JSON.stringify(${JSON.stringify(effectiveConfiguration)}));fs.symlinkSync('/attachments','/workspace/attachments','dir');`;
  docker(['exec', sandbox.worker, 'node', '-e', initialize]);
  // Exercise real Python/tool dispatch without contacting targets or a provider.
  const probe = `const {loadSecHeurConfig}=await import('/opt/secheur/packages/secheur-agent/dist/config.js');const {LegacyToolHost}=await import('/opt/secheur/packages/secheur-agent/dist/legacy-host.js');const c=loadSecHeurConfig({env:{...process.env,SECHEUR_AGENT_DIR:'/state/pi'}});const h=new LegacyToolHost(c);h.setMemoryReferenceEnabled(false);try{const r=await h.call('list_files',{pattern:'/attachments/*',maxEntries:25},undefined,30000);if(!r.ok)throw Error(r.error||'Tool dispatch unavailable');console.log(JSON.stringify({ready:true,toolDispatch:true}));}finally{h.close();}`;
  const preflight = JSON.parse(docker(['exec', sandbox.worker, 'node', '--input-type=module', '-e', probe]));
  const verifier = routes.find(item => item.kind === 'verifier');
  if (!verifier) throw new Error('Missing run-scoped verifier');
  docker(['exec', '--detach', '--env', 'SECHEUR_AGENT_DIR=/state/pi', '--env', 'PI_CODING_AGENT_DIR=/state/pi',
   '--env', 'SECHEUR_MANAGED_SESSIONS=0',
   '--env', `CTF_ORACLE_URL=http://${sandbox.gatewayAddress}:${verifier.listenPort}`, '--env', 'CTF_ORACLE_TOKEN=run-scoped-gateway',
   '--env', `CTF_CHALLENGE_ID=${manifest.challengeId}`, '--env', `CTF_RUN_ID=${manifest.runId}`,
   '--env', 'PI_OFFLINE=1', sandbox.worker, 'sh', '-c',
   'exec node /opt/secheur/packages/secheur-agent/dist/bridge-cli.js > /state/bridge.log 2>&1']);
  return { ...sandbox, status: 'started_preflight_passed', preflight, mode: configuration.mode, effectiveConfiguration, configurationSha256 };
 } catch (error) {
  // The independent run remains available for diagnosis; never fall back to a host bridge.
  writeFileSync(join(sandbox.temporary, 'preflight-error.json'), JSON.stringify({ runId: manifest.runId, error: error.message }), { mode: 0o600 });
  throw error;
 }
}
export function cleanupSandboxWorker(sandbox) {
 // Require ownership labels before stopping exact evaluation resources. Keep private evidence volumes.
 for (const name of [sandbox.worker, sandbox.gateway]) {
  const value = JSON.parse(docker(['inspect', name]))[0];
  if (value.Config.Labels?.['secheur.eval.run'] !== sandbox.runId) throw new Error('Refusing to stop a resource owned by another run');
  docker(['rm', '-f', name]);
 }
 for (const name of [sandbox.network, sandbox.egress]) {
  const value = JSON.parse(docker(['network', 'inspect', name]))[0];
  if (value.Labels?.['secheur.eval.run'] !== sandbox.runId) throw new Error('Refusing to remove another run network');
  docker(['network', 'rm', name]);
 }
}
if (process.argv[1]?.endsWith('sandbox-runner.mjs') && process.argv[2]) {
 const configuration = JSON.parse(readFileSync(process.argv[2], 'utf8'));
 const result = process.argv[3] === '--cleanup' ? cleanupSandboxWorker(configuration) : startSandboxWorker(configuration);
 if (result) console.log(JSON.stringify(result));
}
