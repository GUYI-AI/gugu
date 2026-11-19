// Benchmark only: count successful Node writes/reads to explicitly selected synthetic directories.
const fs = require('node:fs');
const promises = require('node:fs/promises');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
let roots = [], active = false;
const descriptors = new Map();
const counters = { writtenBytes: 0, readBytes: 0, writeCalls: 0, readCalls: 0, syncCalls: 0 };
const tracked = value => {
  if (typeof value === 'number') return descriptors.get(value) === true;
  if (value instanceof URL) value = require('node:url').fileURLToPath(value);
  if (typeof value !== 'string' && !Buffer.isBuffer(value)) return false;
  const name = path.resolve(String(value));
  return roots.some(root => name === root || name.startsWith(root + path.sep));
};
const size = (value, encoding) => typeof value === 'string' ? Buffer.byteLength(value, encoding) : value.byteLength;
const open = fs.openSync.bind(fs), close = fs.closeSync.bind(fs);
fs.openSync = (...args) => { const fd = open(...args); descriptors.set(fd, tracked(args[0])); return fd; };
fs.closeSync = fd => { try { return close(fd); } finally { descriptors.delete(fd); } };
const writeFile = fs.writeFileSync.bind(fs), read = fs.readSync.bind(fs), sync = fs.fsyncSync.bind(fs);
const writeSync = fs.writeSync.bind(fs);
fs.writeSync = (...args) => { const count = writeSync(...args); if (active && tracked(args[0])) { counters.writtenBytes += count; counters.writeCalls++; } return count; };
fs.writeFileSync = (file, data, options) => {
  const before = counters.writeCalls;
  const result = writeFile(file, data, options);
  // Node may route this call through the already measured writeSync hook.
  if (active && tracked(file) && counters.writeCalls === before) { counters.writtenBytes += size(data, typeof options === 'string' ? options : options?.encoding); counters.writeCalls++; }
  return result;
};
fs.readSync = (...args) => { const count = read(...args); if (active && tracked(args[0])) { counters.readBytes += count; counters.readCalls++; } return count; };
fs.fsyncSync = fd => { const result = sync(fd); if (active && tracked(fd)) counters.syncCalls++; return result; };
const promiseOpen = promises.open.bind(promises);
promises.open = async (...args) => {
  const file = await promiseOpen(...args);
  if (!tracked(args[0])) return file;
  for (const method of ['write', 'writev', 'writeFile', 'read', 'sync']) {
    const original = file[method].bind(file);
    file[method] = async (...values) => {
      const result = await original(...values);
      if (active) {
        if (method === 'sync') counters.syncCalls++;
        else if (method === 'read') { counters.readBytes += result.bytesRead; counters.readCalls++; }
        else { counters.writtenBytes += method === 'writeFile' ? size(values[0], typeof values[1] === 'string' ? values[1] : values[1]?.encoding) : result.bytesWritten; counters.writeCalls++; }
      }
      return result;
    };
  }
  return file;
};
globalThis.__turnPayloadIo = {
  start(directories) {
    if (!directories.length || !directories.every(root => typeof root === 'string' && path.isAbsolute(root))) throw new Error('Explicit synthetic roots required');
    roots = directories.map(root => path.resolve(root));
    for (const key of Object.keys(counters)) counters[key] = 0;
    active = true;
  },
  stop() { active = false; return { ...counters }; },
};
syncBuiltinESMExports();
