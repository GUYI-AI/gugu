import { readFile } from 'node:fs/promises';

// Usage: node scripts/acceptance/control-turn-commit-observer.mjs status|start|stop <worker-endpoint.json> [normal|tools|background]
const [action, file, label] = process.argv.slice(2);
if (!['status', 'start', 'stop'].includes(action) || !file) throw new Error('Expected status|start|stop endpoint.json [case]');
const endpoint = JSON.parse(await readFile(file, 'utf8'));
const url = new URL(`/${action}`, endpoint.url);
if (action === 'start') url.searchParams.set('case', label ?? '');
const response = await fetch(url, { method: action === 'status' ? 'GET' : 'POST',
  headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(5000) });
const value = await response.json();
if (!response.ok) throw new Error(JSON.stringify(value));
if (action !== 'stop' && (value.workerId !== endpoint.workerId || value.sourcePin !== endpoint.sourcePin))
  throw new Error('Observer identity changed');
process.stdout.write(JSON.stringify(value, null, 2) + '\n');
if (action === 'stop' && !value.complete) process.exitCode = 2;
