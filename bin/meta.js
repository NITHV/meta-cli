#!/usr/bin/env node
// Entry point. Node 24 runs the TypeScript sources directly (type stripping),
// so there is no build step. Silence the experimental warnings for node:sqlite.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(w.message);
});

await import('../src/cli.ts');
