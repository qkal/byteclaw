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
  // Run oxlint with security-focused rules and only on source files
  // Enable security categories while keeping TypeScript plugin disabled to avoid parsing errors
  const command = `npx oxlint ${fixFlag} --disable-typescript-plugin -D suspicious -D correctness src extensions/*/src packages/*/src --quiet`;
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
