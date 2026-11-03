import { isIP } from 'node:net';

/** Executed by a temporary trusted setup container sharing ONLY the worker network namespace.
 * Never run these rules in the host namespace. Worker remains unprivileged with all capabilities dropped.
 */
export function sandboxFirewallCommands(gatewayAddress, ports) {
 if (isIP(gatewayAddress) !== 4 || ports.length === 0 || ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535))
  throw new Error('Invalid private gateway scope');
 const commands = [['iptables', '-N', 'SECHEUR_EVAL_OUTPUT']];
 commands.push(['iptables', '-A', 'SECHEUR_EVAL_OUTPUT', '-o', 'lo', '-j', 'ACCEPT']);
 for (const port of new Set(ports)) commands.push(['iptables', '-A', 'SECHEUR_EVAL_OUTPUT', '-d', gatewayAddress, '-p', 'tcp', '--dport', String(port), '-j', 'ACCEPT']);
 // Only replies are allowed; no pre-existing executor traffic exists during bootstrap.
 commands.push(['iptables', '-A', 'SECHEUR_EVAL_OUTPUT', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT']);
 commands.push(['iptables', '-A', 'SECHEUR_EVAL_OUTPUT', '-j', 'REJECT']);
 commands.push(['iptables', '-I', 'OUTPUT', '1', '-j', 'SECHEUR_EVAL_OUTPUT']);
 commands.push(['ip6tables', '-P', 'OUTPUT', 'DROP']);
 return commands;
}
