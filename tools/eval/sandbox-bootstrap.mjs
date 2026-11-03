import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, realpathSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluationContainerArguments, evaluationRunNetwork } from '../../packages/secheur-agent/dist/evaluation-sandbox.js';
import { sandboxFirewallCommands } from './sandbox-firewall.mjs';
import { validateRoutes } from './endpoint-gateway.mjs';

function docker(args) {
 const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
 if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr.slice(0, 2000)}`);
 return result.stdout.trim();
}
/** Start only a locked, idle worker. Caller must pass all preflight gates before execing Pi. */
export function bootstrapSandbox(manifest, routes) {
 validateRoutes(routes, manifest.protectedEndpoints);
	for (const route of routes) {
		if (![...manifest.endpoints, ...(manifest.controlEndpoints ?? [])].some(endpoint => endpoint.host === route.host && endpoint.port === route.port))
			throw new Error('Gateway destination is not in the trusted run manifest');
		if (manifest.controlEndpoints?.some(endpoint => endpoint.host === route.host && endpoint.port === route.port) && !['model', 'verifier'].includes(route.kind))
			throw new Error('Control endpoints require a restricted HTTP gateway');
		if (route.kind === 'verifier' && (route.challengeId !== manifest.challengeId || route.runId !== manifest.runId))
			throw new Error('Verification scope differs from the worker run');
	}
 const network = evaluationRunNetwork(manifest.runId);
 const workerArgs = evaluationContainerArguments(manifest, network.name);
	const fingerprint = docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop=ALL',
		'--entrypoint', 'node', manifest.image, '-e',
		"const fs=require('node:fs'),crypto=require('node:crypto');console.log(crypto.createHash('sha256').update(fs.readFileSync('/opt/toolchain.json')).digest('hex'))"]);
	if (fingerprint !== manifest.toolchainDigest) throw new Error('Toolchain fingerprint differs; evaluation may not start');
 const id = createHash('sha256').update(manifest.runId).digest('hex').slice(0, 24);
 const worker = `secheur-eval-${id}`;
 const gateway = `secheur-gateway-${id}`;
	const egress = `secheur-egress-${id}`;
 const temporary = mkdtempSync(join(tmpdir(), 'secheur-gateway-'));
 const gatewayScript = realpathSync(join(import.meta.dirname, 'endpoint-gateway.mjs'));
 if (!lstatSync(gatewayScript).isFile()) throw new Error('Missing trusted gateway');
 const manifestPath = join(temporary, 'gateway.json');
 writeFileSync(manifestPath, '{}', { mode: 0o600 });
 const gatewayConfiguration = `type=bind,src=${manifestPath},dst=/gateway.json,readonly`;
 const verifierSocket = manifest.verifierSocket;
 if (verifierSocket && (realpathSync(verifierSocket) !== '/run/secheur-flag-oracle/verify.sock' || !lstatSync(verifierSocket).isSocket()))
  throw new Error('Only the existing trusted verifier socket may enter the gateway');
 const owned = { network: false, egress: false, worker: false, gateway: false };
 try {
  docker(network.arguments); owned.network = true;
		docker(['network', 'create', '--label', `secheur.eval.run=${manifest.runId}`, egress]); owned.egress = true;
  docker(['create', '--name', gateway, '--network', egress, '--read-only', '--cap-drop=ALL',
   '--security-opt=no-new-privileges', '--user', '0:0', '--label', `secheur.eval.run=${manifest.runId}`,
   '--mount', gatewayConfiguration, '--mount', `type=bind,src=${gatewayScript},dst=/endpoint-gateway.mjs,readonly`,
   '--mount', `type=bind,src=${temporary},dst=/gateway-state`,
   ...(verifierSocket ? ['--mount', `type=bind,src=${verifierSocket},dst=/oracle.sock`] : []),
   '--entrypoint', 'node', manifest.image, '-e', 'setInterval(() => {}, 3600000)']); owned.gateway = true;
  docker(['network', 'connect', network.name, gateway]);
  docker(['start', gateway]);
  const detail = JSON.parse(docker(['inspect', gateway]))[0];
  const address = detail.NetworkSettings.Networks[network.name].IPAddress;
  const gatewayRoutes = routes.map(route => route.kind === 'verifier'
   ? { ...route, journalPath: '/gateway-state/verification.jsonl', ...(verifierSocket ? { socketPath: '/oracle.sock' } : {}) }
   : route.kind === 'model' ? { ...route, diagnosticPath: '/gateway-state/model-requests.jsonl' } : route);
  writeFileSync(manifestPath, JSON.stringify({ bind: address, routes: gatewayRoutes, protectedEndpoints: manifest.protectedEndpoints }), { mode: 0o600 });
  docker(['exec', '--detach', gateway, 'node', '/endpoint-gateway.mjs', '/gateway.json']);
  // No agent or tool runs until namespace firewall installation and assertion succeed.
  docker([...workerArgs.slice(0, -1), '--entrypoint', 'node', manifest.image,
   '-e', 'setInterval(() => {}, 3600000)']); owned.worker = true;
  const commands = sandboxFirewallCommands(address, routes.map(route => route.listenPort));
  const bootstrap = `const {spawnSync}=require('node:child_process'); for(const args of ${JSON.stringify(commands)}) {const r=spawnSync(args[0],args.slice(1)); if(r.status!==0) process.exit(1);}`;
  docker(['run', '--rm', '--network', `container:${worker}`, '--cap-drop=ALL', '--cap-add=NET_ADMIN',
   '--user', '0:0', '--entrypoint', 'node', manifest.image, '-e', bootstrap]);
  // Gateway is the only destination; Docker host gateway and IPv6 are also denied.
  const rules = docker(['run', '--rm', '--network', `container:${worker}`, '--cap-drop=ALL', '--cap-add=NET_ADMIN',
   '--user', '0:0', '--entrypoint', 'iptables', manifest.image, '-S', 'SECHEUR_EVAL_OUTPUT']);
  if (!rules.includes('-j REJECT') || !rules.includes(address)) throw new Error('Missing namespace firewall');
  return { worker, gateway, network: network.name, egress, gatewayAddress: address, temporary,
		routes: routes.map(({ host, port, listenPort, kind }) => ({ host, port, listenPort, kind })),
   bridgeAddress: `http://${JSON.parse(docker(['inspect', worker]))[0].NetworkSettings.Networks[network.name].IPAddress}:14168`,
   runId: manifest.runId, image: manifest.image,
   toolchainDigest: manifest.toolchainDigest, status: 'locked_idle' };
 } catch (error) {
  // Exact resources created in this attempt; never stop an existing bridge or target.
  if (owned.worker) docker(['rm', '-f', worker]);
  if (owned.gateway) docker(['rm', '-f', gateway]);
  if (owned.network) docker(['network', 'rm', network.name]);
		if (owned.egress) docker(['network', 'rm', egress]);
  throw error;
 }
}
