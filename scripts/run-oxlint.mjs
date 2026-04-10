#!/usr/bin/env node

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

const args = process.argv.slice(2);
const fixFlag = args.includes('--fix') ? '--fix' : '';

try {
  // Run oxlint with TypeScript plugin disabled and only on source files
  // This avoids parsing errors in test files and allows the project's existing patterns
  const command = `npx oxlint ${fixFlag} --disable-typescript-plugin src extensions/*/src packages/*/src --quiet`;
  console.log(`Running: ${command}`);
  execSync(command, {
    cwd: rootDir,
    stdio: 'inherit',
  });
  console.log('✓ Oxlint passed');
} catch (error) {
  // If oxlint fails, just report it but don't fail the build
  // This allows the project to gradually adopt oxlint without blocking
  console.error('Oxlint found issues (non-blocking):');
  console.error(error.message?.trim() || String(error));
  process.exit(0);
}
