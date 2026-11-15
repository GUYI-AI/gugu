// Each browser test file loads its modules again in the same page, whose localStorage stays: without this, the read
// model's snapshot (lib/readModel.ts) of the file before would be restored into this one at start. A file starts as a
// fresh install.
for (const key of Object.keys(localStorage)) if (key.startsWith('gugu.readModel.v1')) localStorage.removeItem(key)
