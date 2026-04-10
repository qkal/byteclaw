#!/usr/bin/env node
/**
 * Fallback wrapper script that runs commands with Bun-first, Node fallback.
 * This script attempts to run the command with Bun, and falls back to Node if Bun is not available or fails.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Detects if Bun is available.
 */
function isBunAvailable() {
  try {
    const result = spawn('bun', ['--version'], {
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs a command with Bun or Node fallback.
 */
async function runWithFallback(args) {
  const command = args[0];
  const commandArgs = args.slice(1);

  // Check if Bun is forced via environment variable
  const forceBun = process.env.OPENCLAW_RUNTIME === 'bun';
  const forceNode = process.env.OPENCLAW_RUNTIME === 'node';

  // Determine which runtime to use
  let runtime = 'node';
  if (forceBun) {
    runtime = 'bun';
  } else if (!forceNode && isBunAvailable()) {
    runtime = 'bun';
  }

  console.log(`[run-with-fallback] Using runtime: ${runtime}`);

  // Execute the command
  const spawnArgs =
    runtime === 'bun'
      ? ['bun', command, ...commandArgs]
      : ['node', command, ...commandArgs];

  const proc = spawn(spawnArgs[0], spawnArgs.slice(1), {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  return new Promise((resolve, reject) => {
    proc.on('exit', (code) => {
      if (code === 0) {
        resolve(0);
      } else {
        // If Bun failed and not forced, try Node as fallback
        if (runtime === 'bun' && !forceBun) {
          console.log('[run-with-fallback] Bun failed, falling back to Node');
          const nodeProc = spawn('node', [command, ...commandArgs], {
            stdio: 'inherit',
            shell: process.platform === 'win32',
          });

          nodeProc.on('exit', (nodeCode) => {
            if (nodeCode === 0) {
              resolve(0);
            } else {
              reject(new Error(`Process exited with code ${nodeCode}`));
            }
          });

          nodeProc.on('error', (err) => {
            reject(err);
          });
        } else {
          reject(new Error(`Process exited with code ${code}`));
        }
      }
    });

    proc.on('error', (err) => {
      // If Bun failed to start and not forced, try Node as fallback
      if (runtime === 'bun' && !forceBun) {
        console.log(
          '[run-with-fallback] Bun failed to start, falling back to Node',
        );
        const nodeProc = spawn('node', [command, ...commandArgs], {
          stdio: 'inherit',
          shell: process.platform === 'win32',
        });

        nodeProc.on('exit', (nodeCode) => {
          if (nodeCode === 0) {
            resolve(0);
          } else {
            reject(new Error(`Process exited with code ${nodeCode}`));
          }
        });

        nodeProc.on('error', (nodeErr) => {
          reject(nodeErr);
        });
      } else {
        reject(err);
      }
    });
  });
}

// Run the script
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: run-with-fallback.mjs <command> [args...]');
  process.exit(1);
}

runWithFallback(args).catch((err) => {
  console.error(err);
  process.exit(1);
});
