import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxFirewallCommands } from './sandbox-firewall.mjs';
test('container policy denies host gateway and IPv6 and only permits exact gateway ports', () => {
 const commands = sandboxFirewallCommands('172.29.0.2', [18080, 18080, 18443]);
 const permits = commands.filter(args => args.includes('--dport'));
 assert.equal(permits.length, 2);
 assert.deepEqual(permits.map(args => args[args.indexOf('--dport') + 1]), ['18080', '18443']);
 assert(commands.some(args => args.at(-1) === 'REJECT'));
 assert(commands.some(args => args[0] === 'ip6tables' && args.at(-1) === 'DROP'));
 assert.throws(() => sandboxFirewallCommands('bad', [18080]), /Invalid/);
 assert.throws(() => sandboxFirewallCommands('172.29.0.2', [22]), /Invalid/);
});
