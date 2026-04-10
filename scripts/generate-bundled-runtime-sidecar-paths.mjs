#!/usr/bin/env node

import { writeBundledRuntimeSidecarPathBaseline } from '../src/plugins/runtime-sidecar-paths-baseline.ts';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

await writeBundledRuntimeSidecarPathBaseline({
  repoRoot: rootDir,
  check: false,
});

console.log('Generated bundled-runtime-sidecar-paths.json');
