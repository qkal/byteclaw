# Phase 0: Discovery and Baseline Audit Report

**Date:** 2026-04-10  
**Status:** In Progress  
**Phase:** 0 - Discovery and Baseline

---

## Executive Summary

This report documents the current state of the OpenClaw codebase to inform the Bun-first migration. Key findings:

- **Native dependencies**: 5 critical native modules that require Bun compatibility validation
- **Windows subprocess handling**: Extensive Windows-specific code for .cmd/.bat execution and npm/npx shims
- **Plugin loading**: Heavy reliance on jiti for dynamic module loading with complex alias resolution
- **Worker threads**: Worker pool implementation using Node's worker_threads
- **Current Bun usage**: Minimal - only 1 script explicitly uses Bun
- **No Docker containers**: No Dockerfiles found in repository root
- **Postinstall scripts**: Referenced but file not found at expected location

---

## 1. Native Dependencies Audit

### Critical Native Dependencies (from pnpm-workspace.yaml onlyBuiltDependencies)

| Dependency                               | Version                    | Usage Locations                                                                                                                                                                                                  | Bun Compatibility Status             |
| ---------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **sharp**                                | ^0.34.5                    | Image operations in `src/media/image-ops.ts`, `src/media/store.test.ts`, `src/agents/tool-images.*`                                                                                                              | **UNKNOWN** - Needs testing          |
| **@napi-rs/canvas**                      | ^0.1.89                    | Canvas operations in `src/scripts/canvas-a2ui-copy.test.ts`, `src/media/pdf-extract.ts`, `src/gateway/server*.ts`, `src/canvas-host/`, `src/cli/nodes-cli/register.canvas.ts`, `src/agents/tools/canvas-tool.ts` | **UNKNOWN** - Needs testing          |
| **node-llama-cpp**                       | 3.18.1                     | LLM inference in `src/memory-host-sdk/host/embeddings.ts`, `src/memory-host-sdk/host/node-llama.ts`, `src/plugin-sdk/ollama*`, `src/agents/models-config.providers.ollama.test.ts`                               | **UNKNOWN** - Needs testing          |
| **@matrix-org/matrix-sdk-crypto-nodejs** | ^0.4.0                     | Matrix crypto (extension only) in `extensions/matrix/package.json`                                                                                                                                               | **UNKNOWN** - Needs testing          |
| **@lydell/node-pty**                     | 1.2.0-beta.10              | PTY for terminal in `src/process/supervisor/adapters/pty.ts`, `src/types/lydell-node-pty.d.ts`, bash-tools tests                                                                                                 | **UNKNOWN** - Needs testing          |
| **@discordjs/opus**                      | (in onlyBuiltDependencies) | Discord audio encoding                                                                                                                                                                                           | **UNKNOWN** - Needs testing          |
| **@tloncorp/api**                        | (in onlyBuiltDependencies) | Urbit/Tlon integration                                                                                                                                                                                           | **UNKNOWN** - Needs testing          |
| **@whiskeysockets/baileys**              | (in onlyBuiltDependencies) | WhatsApp integration                                                                                                                                                                                             | **UNKNOWN** - Needs testing          |
| **authenticate-pam**                     | (in onlyBuiltDependencies) | PAM authentication                                                                                                                                                                                               | **UNKNOWN** - Needs testing          |
| **esbuild**                              | (in onlyBuiltDependencies) | Build tool                                                                                                                                                                                                       | **COMPATIBLE** - esbuild runs on Bun |
| **protobufjs**                           | (in onlyBuiltDependencies) | Protocol buffers                                                                                                                                                                                                 | **UNKNOWN** - Needs testing          |

### Ignored Native Dependencies

- **koffi** - Listed in `ignoredBuiltDependencies` in pnpm-workspace.yaml

### Recommendation

**DO-NOT-TOUCH-EARLY**: All native dependencies must be tested under Bun in isolation before any runtime migration. Create a test script that attempts to load each native module under Bun and reports success/failure.

---

## 2. Windows-Specific Code Paths

### Platform Detection

Found **200+ files** with `process.platform === 'win32'` checks across:

- `src/process/` - Subprocess execution
- `src/infra/` - Infrastructure utilities
- `src/daemon/` - Daemon/service management
- `src/security/` - Security audits
- `src/config/` - Configuration handling
- `src/cli/` - CLI utilities
- `src/agents/` - Agent sandbox and tools
- And many more

### .cmd/.bat File Handling

**Key file**: `src/process/exec.ts`

Windows-specific subprocess handling includes:

- `isWindowsBatchCommand()` - Detects .cmd/.bat extensions
- `escapeForCmdExe()` - Escapes arguments for cmd.exe
- `buildCmdExeCommandLine()` - Builds cmd.exe command lines
- `resolveNpmArgvForWindows()` - Resolves npm/npx to node + cli script to avoid spawn EINVAL
- `resolveCommand()` - Uses `resolveWindowsCommandShim()` for corepack, pnpm, yarn

**Critical note from code** (line 64-66):

```typescript
// Bun-based runs don't ship npm-cli.js next to process.execPath.
// Fall back to npm.cmd/npx.cmd so we still route through cmd wrapper
```

This indicates the codebase already has some Bun awareness!

### Windows Command Shim

**File**: `src/process/windows-command.ts`

Simple utility to add `.cmd` extension to specific commands on Windows:

- corepack
- pnpm
- yarn

### Windows PTY

**File**: `src/plugin-sdk/windows-spawn.ts` and `src/plugin-sdk/windows-spawn.test.ts`

Windows-specific PTY spawning logic.

### Recommendation

**HIGH RISK**: Windows subprocess execution is complex and has Bun-specific comments already. The subprocess abstraction layer (Phase 5) is critical. Test thoroughly on Windows.

---

## 3. Subprocess Execution Patterns

### Child Process Usage

**Import pattern**: `from "node:child_process"` used in 8 files:

- `src/process/exec.ts` - Main execution
- `src/process/spawn-utils.ts` - Spawn utilities
- `src/process/kill-tree.ts` - Process tree killing
- `src/process/supervisor/adapters/child.ts` - Child adapter
- `src/process/exec.test.ts` - Tests
- `src/process/exec.windows.test.ts` - Windows tests
- `src/process/exec.no-output-timer.test.ts` - Timeout tests
- `src/process/child-process-bridge.ts` - Bridge

### Key Patterns

1. **execFile with promisify** - For synchronous-style execution
2. **spawn** - For long-running processes
3. **Windows-specific argv resolution** - npm/npx shims
4. **cmd.exe argument escaping** - Security against injection
5. **Process tree management** - kill-tree.ts for cleanup

### Recommendation

**HIGH RISK**: Subprocess execution is deeply integrated with Windows-specific behavior. The abstraction layer (Phase 5) must preserve all existing behavior.

---

## 4. Worker Threads Usage

### Worker Pool Implementation

**File**: `src/infra/worker-pool.ts`

- Uses `worker_threads` module
- Implements a worker thread pool for CPU-intensive tasks
- Uses `Worker`, `isMainThread`, `parentPort`, `workerData`
- Manages worker lifecycle, task queue, error handling

### Worker Usage Locations

Found in:

- `src/infra/worker-pool.ts` - Main implementation
- `src/test-utils/runtime-source-guardrail-scan.ts` - Test utilities
- `src/infra/bonjour-discovery.ts` - Network discovery
- `src/infra/system-presence.ts` - System detection
- `src/commands/models/list.probe.ts` - Model probing
- `src/auto-reply/reply/commands-subagents/action-agents.test.ts` - Tests
- `src/agents/model-scan.ts` - Model scanning
- `src/agents/tools/sessions-list-tool.ts` - Session listing

### Recommendation

**MEDIUM RISK**: Bun supports worker_threads but behavior may differ. Test worker pool under Bun, especially:

- Worker creation and termination
- Message passing
- Error handling
- Performance characteristics

---

## 5. Plugin Loading Architecture

### Jiti Usage

**Primary loader**: `src/plugins/loader.ts`

Jiti is used extensively throughout the codebase for dynamic module loading:

- `src/plugins/source-loader.ts` - Source loading
- `src/plugins/setup-registry.test.ts` - Setup registry tests
- `src/plugins/sdk-alias.test.ts` - SDK alias tests
- `src/plugins/runtime/runtime-web-channel-plugin.ts` - Runtime web channel
- `src/plugins/runtime/runtime-plugin-boundary.ts` - Runtime boundary
- `src/plugins/public-surface-loader.ts` - Public surface loading
- `src/plugins/jiti-loader-cache.ts` - Jiti cache
- `src/plugins/doctor-contract-registry.test.ts` - Doctor tests
- `src/plugins/bundled-channel-config-metadata.ts` - Bundled config
- `src/plugins/bundled-capability-runtime.ts` - Bundled runtime
- And many more test files

### Plugin Loading Flow

1. **Discovery**: `src/plugins/discovery.ts` - Finds plugins in filesystem
2. **Loader**: `src/plugins/loader.ts` - Main loader with jiti
3. **SDK Alias Resolution**: `src/plugins/sdk-alias.ts` - Complex alias resolution
4. **Manifest Registry**: `src/plugins/manifest-registry.ts` - Manifest management
5. **Runtime**: `src/plugins/runtime/` - Runtime plugin execution

### Jiti Configuration

From `src/plugins/loader.ts` line 260:

```typescript
const loader = createJiti(import.meta.url, {
  alias: buildPluginLoaderAliasMap(),
  interopDefault: true,
  require: buildPluginLoaderJitiOptions(),
});
```

### Recommendation

**HIGH RISK**: Plugin loading is complex and relies on jiti's transpilation and alias resolution. Test jiti under Bun thoroughly, especially:

- Module resolution
- Alias resolution
- Transpilation
- Performance

---

## 6. Current Bun Usage

### Scripts Using Bun

Found **1 script** explicitly using Bun:

- `scripts/run-bundled-extension-oxlint.mjs` - Runs oxlint on bundled extensions

### Package.json Scripts with Bun

From package.json:

- `android:bundle:release`: "bun apps/android/scripts/build-release-aab.ts"
- `test:live:cache`: "bun scripts/check-live-cache.ts"

### Extension Bundles

Several extensions use `bun build`:

- `extensions/diffs/package.json`: "build:viewer": "bun build src/viewer-client.ts --target browser --format esm --minify --outfile assets/viewer-runtime.js"

### Recommendation

**LOW RISK**: Current Bun usage is minimal and isolated. Can serve as reference for successful Bun integration.

---

## 7. Docker Configuration

### Dockerfiles

**Dockerfiles referenced in tests but not found in repository:**

Test file `src/docker-build-cache.test.ts` references these Dockerfiles:

- `Dockerfile` (root)
- `scripts/e2e/Dockerfile`
- `scripts/e2e/Dockerfile.qr-import`
- `scripts/docker/cleanup-smoke/Dockerfile`
- `Dockerfile.sandbox`
- `Dockerfile.sandbox-browser`
- `Dockerfile.sandbox-common`

**Status**: None of these files exist in the current repository. This suggests:

- Docker configuration may be in a separate branch
- Dockerfiles may be generated during build
- Test may be outdated
- Docker configuration may be in a different repository

### Docker-Related Scripts

Package.json has extensive `test:docker:*` scripts:

- `test:docker:all` - Runs all Docker tests
- `test:docker:live-build` - Live build tests
- `test:docker:live-gateway` - Gateway tests
- `test:docker:live-models` - Model tests
- `test:docker:onboard` - Onboarding tests
- `test:docker:openwebui` - OpenWebUI tests
- `test:docker:plugins` - Plugin tests
- And many more

**Note**:### Missing Scripts Referenced

The Docker test also references:

- `scripts/npm-runner.mjs` - Not found
- `scripts/windows-cmd-helpers.mjs` - Not found

### Additional Missing Scripts

During Phase 0 testing, discovered additional missing scripts:

- `scripts/run-vitest.mjs` - Referenced in package.json test scripts, not found
- Test configuration directory `test/vitest/` - Referenced in package.json, directory doesn't exist in repository.

### Recommendation

**BLOCKING**: Docker configuration is missing or in a different location. Must resolve before Phase 8 (Docker migration). Options:

1. Check if Dockerfiles are in a different branch
2. Check if Dockerfiles are generated during build
3. Update or remove the docker-build-cache.test.ts test
4. Locate the actual Docker configuration

---

## 8. Postinstall Scripts

### Package.json Reference

```json
"postinstall": "node scripts/postinstall-bundled-plugins.mjs"
```

### File Status

**File not found** at `scripts/postinstall-bundled-plugins.mjs`

### Found Postinstall Scripts

- `packages/clawdbot/scripts/postinstall.js`
- `packages/moltbot/scripts/postinstall.js`

### Recommendation

**INVESTIGATION NEEDED**: The main postinstall script is referenced but not found. This may be:

- Generated during build
- Located elsewhere
- A configuration error

Must resolve before Phase 2 (script migration).

---

## 9. Module System

### ESM Configuration

```json
"type": "module"
```

### TypeScript Configuration

```json
{
  "module": "NodeNext",
  "moduleResolution": "NodeNext",
  "target": "es2023"
}
```

### Node Protocol Imports

Found **1220+ instances** of `from "node:*"` imports across the codebase. This is good for Bun compatibility as Bun supports node: protocol.

### Recommendation

**LOW RISK**: ESM with NodeNext is well-supported by Bun. Node: protocol imports are compatible.

---

## 10. Test Infrastructure

### Test Runner

Vitest is used (referenced in package.json scripts as `node scripts/run-vitest.mjs`).

### Test Configurations

No `vitest.config.ts` found at root, but package.json references:

- `test/vitest/vitest.unit.config.ts`
- `test/vitest/vitest.gateway.config.ts`
- `test/vitest/vitest.channels.config.ts`
- `test/vitest/vitest.extensions.config.ts`
- `test/vitest/vitest.e2e.config.ts`
- And more

### Test Scripts

Extensive test script matrix:

- `test` - Main test runner
- `test:fast`, `test:unit` - Unit tests
- `test:gateway`, `test:channels` - Component tests
- `test:e2e` - End-to-end tests
- `test:live:*` - Live API tests
- `test:docker:*` - Docker integration tests

### Recommendation

**HIGH RISK**: Test runner migration (Phase 3) is critical. Vitest under Bun may have different mock behavior, timing, and isolation.

---

## 11. Build Pipeline

### Build Tool

esbuild is used via `esbuild.config.mjs`:

- Targets node22
- Bundles CLI entrypoint
- Keeps library unbundled
- Externalizes heavy dependencies

### Build Scripts

- `build` - Main build
- `build:watch` - Watch mode
- `build:plugin-sdk:dts` - Type definitions
- `build:docker` - Docker build
- `build:strict-smoke` - Strict smoke test

### Recommendation

**LOW RISK**: esbuild runs on Bun. Build script migration (Phase 2) should be straightforward.

---

## 12. Risk Summary

### DO-NOT-TOUCH-EARLY

1. **Native dependencies** - All must be tested under Bun first
2. **Windows subprocess execution** - Requires abstraction layer
3. **Plugin loading** - Requires jiti compatibility validation

### HIGH RISK

1. **Test runner** - Vitest under Bun may differ
2. **Worker threads** - Bun support exists but behavior may differ
3. **Docker containers** - Unknown configuration

### MEDIUM RISK

1. **Filesystem semantics** - Bun may have edge case differences
2. **HTTP/fetch behavior** - Bun's fetch vs Node's undici
3. **Timers and event loop** - Different timing characteristics

### LOW RISK

1. **Build scripts** - esbuild compatible
2. **Lint/typecheck** - Runtime-agnostic
3. **Module system** - ESM with NodeNext compatible

---

## 13. Immediate Next Steps

### Before Phase 1

1. **Create native dependency test script**: Test each native module under Bun
2. **Locate postinstall script**: Find or fix the missing postinstall-bundled-plugins.mjs
3. **Locate Docker configuration**: Find Dockerfiles or container strategy
4. **Run test baseline**: Execute full test suite on Node and capture results
5. **Benchmark CLI startup**: Run `test:startup:bench:save` on Node

### Phase 1 Preparation

1. Add Bun to devDependencies
2. Create runtime detection utilities
3. Create comparison tools
4. Establish CI matrix (if CI exists)

---

## 14. Open Questions

1. **Where is the postinstall script?** Referenced but not found
2. **Where are Dockerfiles?** No Docker configuration found
3. **What is the CI setup?** No .github directory found
4. **Are there other native dependencies?** Only checked onlyBuiltDependencies list
5. **What is the extent of Matrix SDK usage?** Only in extension

---

## 15. Audit Checklist Status

- [x] Catalog all native dependencies
- [x] Check Bun compatibility status (marked as unknown, needs testing)
- [x] Document subprocess execution patterns
- [x] Catalog Windows-specific code paths
- [x] Identify scripts currently using Bun
- [ ] Run full test suite on Node and capture baseline
- [ ] Benchmark CLI startup time under Node
- [ ] Map plugin loading flow end-to-end (partial - jiti usage documented)
- [ ] Verify CI/CD setup and test matrix (no CI found)
- [ ] Create migration tracking document

---

## Appendix A: File Inventory

### Key Files for Migration

- `src/process/exec.ts` - Subprocess execution (Windows handling)
- `src/process/windows-command.ts` - Windows command shims
- `src/process/spawn-utils.ts` - Spawn utilities
- `src/process/kill-tree.ts` - Process tree management
- `src/plugins/loader.ts` - Main plugin loader
- `src/plugins/sdk-alias.ts` - SDK alias resolution
- `src/infra/worker-pool.ts` - Worker thread pool
- `esbuild.config.mjs` - Build configuration
- `package.json` - Scripts and dependencies
- `pnpm-workspace.yaml` - Workspace and native dependencies

### Test Configuration Files

Need to locate:

- `test/vitest/vitest.unit.config.ts`
- `test/vitest/vitest.gateway.config.ts`
- `test/vitest/vitest.channels.config.ts`
- `test/vitest/vitest.extensions.config.ts`
- `test/vitest/vitest.e2e.config.ts`

---

**End of Phase 0 Audit Report**
