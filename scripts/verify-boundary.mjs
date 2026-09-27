// Trusted controller discovers fresh Docker addresses and checks live services before probing the agent.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const compose = (...args) => docker('compose', ...args);
function docker(...args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}
function trustedProbe(service, targets) {
  const source = `const {connect}=require('node:net');
    Promise.all(${JSON.stringify(targets)}.map(({host,port})=>new Promise((resolve,reject)=>{
      const socket=connect({host,port});socket.once('connect',()=>{socket.destroy();resolve();});
      socket.once('error',reject);socket.setTimeout(2000,()=>{socket.destroy();reject(new Error('Unavailable'));});
    }))).catch(()=>{console.error('Trusted reachability failed');process.exitCode=1;});`;
  compose('exec', '-T', service, 'node', '-e', source);
}
const targets = [];
for (const [service, port, trusted] of [['provider', 3001, 'api'], ['db', 5432, 'api'], ['provider-db', 5432, 'provider']]) {
  const id = compose('ps', '-q', service);
  assert.ok(id, `${service} must be running`);
  const [container] = JSON.parse(docker('inspect', id));
  assert.equal(container.State.Health?.Status, 'healthy', `${service} must be healthy`);
  assert.equal(Object.keys(container.HostConfig.PortBindings ?? {}).length, 0);
  const addresses = new Set(Object.values(container.NetworkSettings.Networks)
    .flatMap(network => [network.IPAddress, network.GlobalIPv6Address]).filter(Boolean));
  assert.ok(addresses.size, `No private addresses for ${service}`);
  const serviceTargets = [{ host: service, port }, ...[...addresses].map(host => ({ host, port }))];
  // Provider's DB-facing interface is reachable from itself; test every discovered interface too.
  trustedProbe(trusted, [{ host: service, port }]);
  trustedProbe(service === 'provider' ? 'provider' : trusted, serviceTargets.slice(1));
  targets.push(...serviceTargets);
}
console.log(compose('run', '--rm', '--no-deps', '-T', 'agent', 'node', 'boundary-probe.mjs', JSON.stringify(targets)));
