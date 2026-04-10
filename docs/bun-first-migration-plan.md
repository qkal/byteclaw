# Bun-First Migration Plan for OpenClaw

**Status:** Planning Phase  
**Date:** 2026-04-10  
**Target:** Bun as primary runtime with full Node.js compatibility preserved

---

## A. Executive Summary

A full Bun-first migration is **realistic but high-risk** for this codebase. The project has:

- **Complex subprocess surface**: Windows-specific cmd.exe handling, .bat/.cmd shims, npm/npx resolution
- **Native dependencies**: sharp, @napi-rs/canvas, node-llama-cpp, @matrix-org/matrix-sdk-crypto-nodejs, @lydell/node-pty that may not run under Bun
- **Dynamic plugin loading**: jiti-based plugin system with complex alias resolution
- **Extensive test matrix**: Docker-based integration tests, live API tests, platform-specific tests
- **Mixed Bun usage already**: Some scripts already use Bun (android:bundle:release, test:live:cache, extension builds)

**Biggest technical risks:**

1. Native dependency compatibility (sharp, canvas, llama-cpp, matrix crypto)
2. Windows subprocess execution semantics (cmd.exe, .bat/.cmd, npm shims)
3. Plugin loading behavior under Bun's module resolution
4. Test runner parity (Vitest under Bun vs Node)
5. Docker container builds and runtime detection
6. Extension ecosystem assumptions about Node internals

**Highest-leverage migration steps:**

1. Establish Bun+Node dual-path execution scaffolding first
2. Migrate build scripts (lowest risk, highest visibility)
3. Create runtime abstraction layer for subprocess execution
4. Establish CI matrix proving Bun/Node parity before defaulting
5. Migrate test runner only after parity data exists

**What absolutely must not be rushed:**

- Switching the default runtime before CI proves equivalence
- Migrating subprocess execution before abstraction layer exists
- Changing plugin loading without testing under both runtimes
- Removing Node-compatible code paths before CI validates Bun behavior
- Migrating Docker containers before runtime detection is solid

---

## B. Migration Principles

1. **Dual-path before default**: Every Bun-first script must have a Node-compatible execution path until CI proves equivalence. Never replace Node with Bun without a fallback.

2. **Runtime before test runner**: Do not switch runtime and test runner in the same phase unless parity data already exists from a previous phase.

3. **Evidence over assumptions**: Require CI evidence (passing tests, benchmark parity, integration test success) before declaring Bun-equivalent to Node for any surface.

4. **Native dependency audit first**: Audit all native dependencies for Bun compatibility before any runtime migration. Block migration on incompatible natives.

5. **Subprocess abstraction**: Introduce a subprocess abstraction layer before changing spawn/exec behavior. Do not patch Node child_process calls directly.

6. **Plugin loading isolation**: Test plugin loading under Bun in isolation before integrating. Plugin system must work identically under both runtimes.

7. **CI matrix validation**: CI must run critical paths on both Bun and Node throughout migration. Do not remove Node CI jobs until Bun is default and proven stable.

8. **Incremental script migration**: Migrate scripts one-by-one or in small groups, not en masse. Each script migration must be independently validated.

9. **Docker runtime detection**: Docker containers must detect and support both runtimes. Do not hardcode Bun in Dockerfiles until Node support is explicitly preserved.

10. **Extension compatibility**: Extensions must work under both runtimes. Do not introduce Bun-specific APIs for extensions.

11. **Build output compatibility**: Build artifacts (dist/, openclaw.mjs) must run under both Node and Bun until Bun is default.

12. **Rollback always possible**: Every phase must have clear rollback criteria and a documented rollback procedure. No phase should leave the codebase in a state where Node support is broken without obvious fix.

---

## C. Current-State Audit Checklist

### Runtime Execution Surface

- [ ] **CLI entrypoints**: Audit `src/entry.ts`, `openclaw.mjs` shebang, package.json `bin` field
- [ ] **Long-running services**: Identify daemon processes, gateway server, TUI main loops
- [ ] **Scripts**: Catalog all scripts in `scripts/` directory and their runtime assumptions
- [ ] **Worker threads**: Search for `worker_threads` usage across codebase
- [ ] **Subprocess spawning**: Audit `src/process/exec.ts`, `spawn-utils.ts`, all child_process usage
- [ ] **Shell assumptions**: Identify shell-specific code (Windows cmd.exe, bash, POSIX assumptions)
- [ ] **Environment variable handling**: Check `process.env` usage, dotenv loading, env validation
- [ ] **Filesystem behavior**: Audit fs operations, path resolution, temp file handling
- [ ] **Path resolution**: Check import.meta.url, \_\_dirname usage, path module assumptions
- [ ] **Timers/streams/buffers**: Identify setTimeout/setInterval, stream APIs, Buffer usage
- [ ] **HTTP/fetch usage**: Audit undici, fetch, HTTP server usage (express, hono)
- [ ] **WebSocket behavior**: Check ws library usage, WebSocket server/client code

### Module and Build Surface

- [ ] **ESM/CJS interop**: Verify `type: "module"` in package.json, check for any .cjs files
- [ ] **tsconfig assumptions**: Audit `tsconfig.json`, `tsconfig.plugin-sdk.dts.json`, target/lib settings
- [ ] **Transpilation pipeline**: Review `esbuild.config.mjs`, build targets, external dependencies
- [ ] **Bundling boundaries**: Identify what gets bundled (CLI entry) vs what stays unbundled (library, plugin-sdk)
- [ ] **Import path assumptions**: Check path aliases, plugin-sdk exports, extension-api resolution
- [ ] **Dynamic imports**: Audit `import()`, lazy loading, lazy-runtime.ts usage
- [ **Extensions/plugins loading**: Review `src/plugins/loader.ts`, jiti configuration, alias resolution
- [ ] **Build scripts**: Audit all build-related package.json scripts for runtime assumptions

### Test Surface

- [ ] **Current runner**: Locate all vitest.config.ts files, understand test runner setup
- [ ] **Mock APIs**: Identify Node-specific mocks (process, fs, child_process)
- [ ] **Node-only test helpers**: Find test utilities that assume Node internals
- [ ] **Snapshot behavior**: Check snapshot tests for runtime-sensitive output
- [ ] **Subprocess/integration tests**: Catalog tests that spawn processes or run integration scenarios
- [ ] **Filesystem tests**: Identify tests with fs operations, temp file handling
- [ ] **Timing-sensitive tests**: Find tests with setTimeout, race conditions, timing assertions
- [ ] **Watch mode**: Verify test watch mode behavior
- [ ] **CI behavior**: Understand how tests run in CI environment
- [ ] **Live tests**: Catalog `test:live:*` scripts and their runtime requirements

### Tooling and Developer Workflow

- [ ] **Local dev commands**: Audit `pnpm dev`, `pnpm start`, `pnpm gateway:dev`, TUI commands
- [ ] **Debugging workflows**: Check if any debugger configurations assume Node
- [ ] **Lint/typecheck/build/test separation**: Verify each step works independently
- [ ] **Precommit/prepush hooks**: Review git hooks, prepare script, prepush:ci
- [ ] **Release scripts**: Audit release-related scripts, npm publish flows
- [ ] **Container workflows**: Check Docker-related scripts, build:docker, test:docker:\*
- [ ] **Cross-platform development**: Verify Windows/Mac/Linux development workflows

### Compatibility Surface

- [ ] **Runtime-sensitive packages**: Audit dependencies list for known Bun incompatibilities
- [ ] **Native dependencies**: Verify sharp, @napi-rs/canvas, node-llama-cpp, @matrix-org/matrix-sdk-crypto-nodejs, @lydell/node-pty
- [ ] **Postinstall/build scripts**: Check all postinstall scripts in package.json and dependencies
- [ ] **Node-only libraries**: Identify dependencies that explicitly require Node
- [ ] **Extensions assuming Node**: Audit extension code for Node-specific assumptions
- [ ] **Safe under Bun**: Categorize dependencies as likely safe vs risky under Bun

### Production and CI/CD Surface

- [ ] **CI matrix strategy**: Determine current CI setup (no .github found - may use external CI)
- [ ] **Lockstep verification**: Plan for running same tests on both Bun and Node
- [ ] **Build artifacts**: Verify dist/, openclaw.mjs work under both runtimes
- [ ] **Release packaging**: Audit npm publish process, included files
- [ ] **Docker/container images**: Check Dockerfile locations, base images, runtime installation
- [ ] **Runtime fallback strategy**: Plan for how to detect and fall back to Node if Bun fails
- [ ] **Observability**: Plan for monitoring migration regressions in production

---

## D. Risk Classification Matrix

| Area                                                              | Risk Level             | Why                                                                   | Likely Failure Mode                                                 | Evidence to Reduce Uncertainty                                              |
| ----------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Native dependencies (sharp, canvas, llama-cpp, matrix crypto)** | **DO-NOT-TOUCH-EARLY** | Bun may not support these native modules                              | Build failures, runtime crashes, missing symbols                    | Test each native dep under Bun in isolation, check Bun compatibility matrix |
| **Windows subprocess execution (cmd.exe, .bat/.cmd, npm shims)**  | **HIGH**               | Bun's child_process may not match Node's Windows behavior exactly     | Command execution failures, path resolution issues, shell injection | Port subprocess abstraction layer, run Windows integration tests under Bun  |
| **Plugin loading (jiti, dynamic imports, alias resolution)**      | **HIGH**               | Bun's module resolution differs from Node's                           | Plugins fail to load, import errors, alias mismatches               | Load test plugins under Bun, verify jiti compatibility                      |
| **Test runner (Vitest under Bun vs Node)**                        | **HIGH**               | Bun's test runner may have different mock behavior, timing, isolation | Flaky tests, different coverage, false positives/negatives          | Run full test suite under Bun, compare results with Node                    |
| **Docker container builds**                                       | **HIGH**               | Container base images may not include Bun, runtime detection needed   | Containers fail to start, wrong runtime selected                    | Build containers with Bun, test runtime detection logic                     |
| **Extension ecosystem compatibility**                             | **MEDIUM**             | Extensions may assume Node internals                                  | Extensions fail under Bun, missing APIs                             | Sample extension testing under Bun, document compatibility requirements     |
| **HTTP/fetch behavior (undici vs native fetch)**                  | **MEDIUM**             | Bun's fetch may differ from Node's undici                             | Network errors, different headers, streaming issues                 | Compare fetch behavior between runtimes, test network code                  |
| **Filesystem semantics**                                          | **MEDIUM**             | Bun's fs may have edge case differences                               | File not found errors, permission issues, race conditions           | Filesystem integration tests under Bun                                      |
| **Build scripts (esbuild, TypeScript compilation)**               | **LOW**                | esbuild runs under both, TypeScript is runtime-agnostic               | Build failures if Bun breaks esbuild                                | Run full build under Bun, verify output identical                           |
| **Lint/typecheck (oxlint, tsc)**                                  | **LOW**                | These are build-time tools, runtime-agnostic                          | Minimal risk                                                        | Run under Bun, verify identical results                                     |
| **Package manager (pnpm)**                                        | **LOW**                | pnpm works with both runtimes                                         | Minimal risk                                                        | Verify pnpm commands work under Bun                                         |
| **Environment variable handling**                                 | **LOW**                | process.env is standard across runtimes                               | Minimal risk                                                        | Test env loading under Bun                                                  |
| **Timers and event loop**                                         | **MEDIUM**             | Bun's event loop may have different timing characteristics            | Timing-sensitive tests fail, race conditions                        | Test timer-heavy code under Bun, compare behavior                           |

---

## E. Phased Migration Roadmap

### Phase 0: Discovery and Baseline

**Purpose**: Establish current state, identify blockers, create measurement baseline.

**Scope**:

- Audit only, no code changes
- Document current runtime assumptions
- Identify native dependencies and their Bun compatibility
- Establish test baseline on Node

**Tasks**:

1. Complete current-state audit checklist (Section C)
2. Catalog all native dependencies and check Bun compatibility matrix
3. Run full test suite on Node, capture baseline results (pass/fail, coverage, timing)
4. Benchmark CLI startup time under Node (test:startup:bench:save)
5. Document all subprocess execution patterns in codebase
6. Catalog all Windows-specific code paths
7. Identify all scripts that currently use Bun and document why
8. Map plugin loading flow end-to-end
9. Verify CI/CD setup and current test matrix
10. Create migration tracking document with decision log

**Validation**:

- Audit checklist complete
- Native dependency compatibility report generated
- Test baseline saved (results, coverage, timing)
- Subprocess execution patterns documented
- Plugin loading flow documented

**Exit criteria**:

- All audit items completed
- Native dependency blockers identified and documented
- Test baseline established and saved
- No unknown runtime assumptions remain

**Rollback triggers**: N/A (read-only phase)

**Deliverables**:

- Audit report document
- Native dependency compatibility matrix
- Test baseline results (saved in .artifacts/)
- Subprocess execution pattern documentation
- Plugin loading flow documentation
- Migration decision log template

---

### Phase 1: Compatibility Scaffolding

**Purpose**: Build infrastructure to support dual-path execution and measurement.

**Scope**:

- Add Bun to devDependencies
- Create runtime detection utilities
- Add CI matrix for Bun+Node
- Create measurement/comparison tools
- No changes to production code

**Tasks**:

1. Add Bun as optional devDependency with version pin
2. Create `src/shared/runtime-detection.ts` with:
   - `isBun()`, `isNode()`, `getRuntime()`, `getRuntimeVersion()`
   - Runtime-aware error reporting
3. Create `scripts/runtime-compare.mjs` to run commands under both runtimes and compare output
4. Add CI job (if CI exists) or local script to run:
   - Full test suite under Bun
   - Full test suite under Node
   - Comparison report
5. Create `scripts/bun-parity-check.mjs` to:
   - Run critical commands under both runtimes
   - Compare exit codes, stdout, stderr, timing
   - Fail if significant differences detected
6. Add `OPENCLAW_RUNTIME` env var to force runtime (for testing)
7. Create documentation for runtime detection usage
8. Add Bun version to system info output (if exists)

**Validation**:

- Bun installs successfully
- Runtime detection works correctly
- Comparison tools can run same command under both runtimes
- CI/local matrix can run tests under both runtimes
- Env var override works

**Exit criteria**:

- Bun installed and version pinned
- Runtime detection utilities available and tested
- Comparison tools working
- CI/local matrix running tests under both runtimes
- Baseline comparison results captured (Bun vs Node differences documented)

**Rollback triggers**:

- Bun fails to install on any platform
- Runtime detection produces incorrect results
- Comparison tools cannot execute under Bun

**Deliverables**:

- Runtime detection module
- Comparison tools
- CI matrix configuration (or local equivalent)
- Baseline Bun vs Node comparison report
- Runtime detection documentation

---

### Phase 2: Script Migration (Build and Tooling)

**Purpose**: Migrate build and tooling scripts to Bun-first with Node fallback.

**Scope**:

- Build scripts (esbuild, TypeScript compilation)
- Lint/typecheck scripts
- Code generation scripts
- NOT: Runtime execution scripts, test scripts, CLI entrypoint

**Tasks**:

1. Create `scripts/run-with-fallback.mjs` helper:
   - Tries Bun first, falls back to Node on failure
   - Logs which runtime is being used
   - Supports env var override
2. Migrate build scripts in order (one at a time, validate each):
   - `build` → `bun node esbuild.config.mjs` with Node fallback
   - `build:watch` → Bun-first with fallback
   - `build:plugin-sdk:dts` → Bun-first (tsc) with fallback
   - `build:docker` → Bun-first with fallback
   - `canvas:a2ui:bundle` → Already uses Bun, add fallback
3. Migrate lint scripts:
   - `lint` → Bun-first with fallback
   - `lint:fix` → Bun-first with fallback
   - All `lint:*` variants → Bun-first with fallback
4. Migrate code generation scripts:
   - `config:schema:gen` → Bun-first with fallback
   - `config:channels:gen` → Bun-first with fallback
   - `plugin-sdk:api:gen` → Bun-first with fallback
   - All other `*:gen` scripts → Bun-first with fallback
5. Update each script's package.json entry to use fallback wrapper
6. Add validation: after each script migration, run under both runtimes and verify identical output
7. Update documentation to reflect Bun-first with Node fallback

**Validation**:

- Each migrated script produces identical output under Bun and Node
- Build artifacts are byte-for-byte identical
- Type definitions identical
- Generated code identical
- No regression in script execution time

**Exit criteria**:

- All build scripts Bun-first with Node fallback
- All lint scripts Bun-first with Node fallback
- All code generation scripts Bun-first with Node fallback
- All scripts validated to produce identical output under both runtimes
- Documentation updated

**Rollback triggers**:

- Any script produces different output under Bun vs Node
- Build artifacts differ between runtimes
- Script execution time degrades significantly under Bun
- Script fails under Bun but works under Node (fallback path exercised)

**Deliverables**:

- Fallback wrapper script
- Migrated build scripts
- Migrated lint scripts
- Migrated code generation scripts
- Validation results for each script
- Updated documentation

---

### Phase 3: Test Runner Migration

**Purpose**: Migrate test execution to Bun-first while maintaining Node test coverage.

**Scope**:

- Test runner execution (Vitest)
- NOT: Test code changes, test behavior changes
- Maintain full Node test coverage in CI

**Tasks**:

1. Audit all vitest.config.ts files for Node-specific assumptions
2. Create test runner wrapper `scripts/run-test.mjs`:
   - Runs tests under Bun by default
   - Supports `OPENCLAW_TEST_RUNTIME=node` to force Node
   - Logs runtime being used
3. Update test scripts to use wrapper:
   - `test` → Bun-first with Node override
   - `test:fast`, `test:unit` → Bun-first with Node override
   - `test:changed` → Bun-first with Node override
4. Add CI matrix (or local validation):
   - Run full test suite under Bun (default)
   - Run full test suite under Node (parity check)
   - Compare results, fail if significant differences
5. Run test suite under Bun, document any failing tests
6. Fix failing tests (only if Bun incompatibility, not test logic issues):
   - Add Bun-specific test helpers if needed
   - Use runtime detection for conditional behavior
   - Document why changes were needed
7. Verify test coverage identical under both runtimes
8. Verify test timing similar under both runtimes (within 20% tolerance)
9. Update test documentation

**Validation**:

- Test suite passes under Bun
- Test suite passes under Node (parity)
- Test coverage identical between runtimes
- Test timing within acceptable tolerance
- No tests skipped or excluded under Bun

**Exit criteria**:

- Test runner Bun-first by default
- All tests pass under Bun
- All tests pass under Node (CI parity job)
- Coverage identical between runtimes
- Timing within tolerance
- Documentation updated

**Rollback triggers**:

- Tests fail under Bun that pass under Node (and cannot be fixed reasonably)
- Significant coverage loss under Bun
- Test execution time degrades significantly under Bun (>2x slower)
- Flaky tests introduced under Bun

**Deliverables**:

- Test runner wrapper
- Migrated test scripts
- Bun/Node test parity validation results
- Any Bun-specific test helpers
- Updated test documentation

---

### Phase 4: Runtime Entrypoint Migration

**Purpose**: Migrate CLI and runtime entrypoints to Bun-first with Node fallback.

**Scope**:

- CLI entrypoint (openclaw.mjs, src/entry.ts)
- Main runtime execution scripts
- NOT: Subprocess execution, plugin loading, internal runtime behavior

**Tasks**:

1. Audit `src/entry.ts` for Node-specific assumptions
2. Audit `openclaw.mjs` shebang and bootstrap
3. Create runtime-aware entrypoint wrapper:
   - Detects if Bun is available
   - Prefers Bun for execution
   - Falls back to Node if Bun unavailable or fails
   - Logs runtime choice
4. Update CLI scripts:
   - `start` → Bun-first with fallback
   - `dev` → Bun-first with fallback
   - `openclaw` → Bun-first with fallback
   - `tui` → Bun-first with fallback
   - `gateway:dev` → Bun-first with fallback
5. Test CLI startup under both runtimes:
   - Measure startup time (test:startup:bench)
   - Verify identical behavior
   - Test all major CLI commands under both
6. Add runtime detection to CLI help output
7. Update shebang in openclaw.mjs to be runtime-agnostic
8. Validate that CLI works under both runtimes for:
   - Basic commands
   - Gateway mode
   - Agent mode
   - TUI mode
9. Update CLI documentation

**Validation**:

- CLI starts successfully under Bun
- CLI starts successfully under Node
- CLI behavior identical under both runtimes
- Startup time not significantly slower under Bun
- All major CLI commands work under both runtimes

**Exit criteria**:

- CLI entrypoint Bun-first with Node fallback
- All CLI scripts Bun-first with fallback
- CLI validated under both runtimes
- Startup performance acceptable
- Documentation updated

**Rollback triggers**:

- CLI fails to start under Bun
- CLI behavior differs significantly between runtimes
- Startup time degrades significantly under Bun
- Major CLI commands fail under Bun

**Deliverables**:

- Runtime-aware entrypoint wrapper
- Migrated CLI scripts
- CLI validation results
- Updated shebang
- Updated CLI documentation

---

### Phase 5: Subprocess Abstraction

**Purpose**: Create abstraction layer for subprocess execution to hide runtime differences.

**Scope**:

- Subprocess execution abstraction
- Windows-specific handling
- npm/npx resolution
- NOT: Actual migration of subprocess calls (that's next phase)

**Tasks**:

1. Design subprocess abstraction interface:
   - `execCommand(command, args, options)`
   - `spawnProcess(command, args, options)`
   - Platform-specific handling abstracted
2. Implement abstraction for Node:
   - Wrapper around child_process.execFile, spawn
   - Windows cmd.exe handling preserved
   - npm/npx shim resolution preserved
3. Implement abstraction for Bun:
   - Use Bun's spawn/exec APIs
   - Match Node's Windows behavior as closely as possible
   - Handle npm/npx resolution for Bun
4. Create runtime-aware subprocess module:
   - Detects runtime
   - Returns appropriate implementation
   - Logs implementation choice
5. Add comprehensive tests for abstraction layer:
   - Test under both runtimes
   - Test Windows-specific scenarios
   - Test npm/npx resolution
   - Test error handling
6. Document subprocess abstraction usage
7. Create migration guide for subprocess calls

**Validation**:

- Abstraction layer works under Node
- Abstraction layer works under Bun
- Behavior identical between implementations (where possible)
- Windows-specific handling works under Bun
- npm/npx resolution works under Bun
- Comprehensive test coverage

**Exit criteria**:

- Subprocess abstraction implemented
- Tests passing under both runtimes
- Windows handling validated
- npm/npx resolution validated
- Documentation complete

**Rollback triggers**:

- Cannot match Node's Windows behavior under Bun
- npm/npx resolution cannot be made to work under Bun
- Abstraction introduces significant overhead
- Tests show behavioral differences that cannot be reconciled

**Deliverables**:

- Subprocess abstraction interface
- Node implementation
- Bun implementation
- Runtime-aware module
- Comprehensive tests
- Documentation and migration guide

---

### Phase 6: Subprocess Call Migration

**Purpose**: Migrate all subprocess calls to use abstraction layer.

**Scope**:

- All child_process.exec, spawn, execFile calls
- Windows-specific subprocess code
- npm/npx execution
- NOT: Plugin subprocess handling (separate phase)

**Tasks**:

1. Catalog all subprocess calls in codebase:
   - Direct child_process usage
   - Windows-specific code in src/process/
   - npm/npx execution
2. Migrate calls in priority order:
   - Core runtime subprocess calls (src/process/exec.ts)
   - Windows-specific handling (windows-command.ts, windows-spawn.ts)
   - Build subprocess calls
   - Other subprocess calls
3. For each migration:
   - Replace direct child_process call with abstraction
   - Add runtime detection logging
   - Test under both runtimes
   - Verify identical behavior
4. Update type definitions if needed
5. Remove direct child_process imports where no longer needed
6. Run full test suite under both runtimes
7. Run integration tests under both runtimes

**Validation**:

- All subprocess calls use abstraction
- Tests pass under Node
- Tests pass under Bun
- Integration tests pass under both runtimes
- Behavior identical between runtimes

**Exit criteria**:

- All subprocess calls migrated
- All tests passing under both runtimes
- Integration tests passing under both runtimes
- No direct child_process usage remaining (except in abstraction layer)

**Rollback triggers**:

- Tests fail under Bun after migration
- Integration tests fail under Bun
- Behavior differs between runtimes
- Cannot migrate specific call without breaking functionality

**Deliverables**:

- Migrated subprocess calls
- Updated test results
- Integration test results
- Removed direct child_process usage

---

### Phase 7: Plugin Loading Validation

**Purpose**: Validate plugin loading works under Bun without changes.

**Scope**:

- Plugin loading system testing
- jiti compatibility
- Plugin alias resolution
- NOT: Changing plugin loading code (unless absolutely necessary)

**Tasks**:

1. Test plugin loading under Bun:
   - Load sample plugins under Bun
   - Verify plugin initialization
   - Verify plugin API access
   - Test plugin lifecycle
2. Test jiti under Bun:
   - Verify jiti works with Bun
   - Test jiti's transpilation under Bun
   - Verify jiti's alias resolution under Bun
3. Test plugin SDK resolution under Bun:
   - Verify plugin-sdk exports resolve
   - Test extension-api resolution
   - Test scoped alias resolution
4. Test bundled plugin loading under Bun
5. Test external plugin loading under Bun
6. Document any differences or issues
7. If issues found, create Bun-specific workarounds:
   - Use runtime detection
   - Add Bun-specific code paths
   - Document why workarounds needed
8. Run plugin-related tests under both runtimes

**Validation**:

- Plugins load successfully under Bun
- Plugin initialization works under Bun
- Plugin API access works under Bun
- Plugin lifecycle works under Bun
- jiti works under Bun
- Plugin SDK resolution works under Bun
- Tests pass under both runtimes

**Exit criteria**:

- Plugin loading validated under Bun
- jiti compatibility confirmed
- Plugin SDK resolution confirmed
- Any issues documented and workarounds implemented
- Tests passing under both runtimes

**Rollback triggers**:

- Plugins fail to load under Bun
- jiti incompatible with Bun
- Plugin SDK resolution fails under Bun
- Issues cannot be worked around reasonably

**Deliverables**:

- Plugin loading validation results
- jiti compatibility report
- Plugin SDK resolution validation
- Any Bun-specific workarounds
- Updated test results

---

### Phase 8: Docker and Container Migration

**Purpose**: Update Docker containers to support Bun-first with Node fallback.

**Scope**:

- Dockerfile updates
- Container runtime detection
- Container build scripts
- NOT: Changing container behavior or dependencies

**Tasks**:

1. Audit existing Dockerfiles (if any exist)
2. Create runtime detection script for containers:
   - Detect if Bun is installed
   - Choose runtime based on availability
   - Log runtime choice
3. Update Dockerfiles to:
   - Install Bun alongside Node
   - Use runtime detection for entrypoint
   - Prefer Bun if available
4. Update container build scripts:
   - `build:docker` → Use Bun for build if available
   - Add Node fallback
5. Test container builds with Bun
6. Test container builds with Node
7. Test container runtime with Bun
8. Test container runtime with Node
9. Update container documentation

**Validation**:

- Containers build successfully with Bun
- Containers build successfully with Node
- Containers run successfully with Bun
- Containers run successfully with Node
- Runtime detection works in containers
- Behavior identical between runtimes

**Exit criteria**:

- Dockerfiles updated to include Bun
- Runtime detection in containers
- Container builds work with both runtimes
- Container runtime works with both runtimes
- Documentation updated

**Rollback triggers**:

- Container builds fail with Bun
- Container runtime fails with Bun
- Runtime detection fails in containers
- Significant size increase in containers

**Deliverables**:

- Updated Dockerfiles
- Container runtime detection script
- Updated container build scripts
- Container validation results
- Updated container documentation

---

### Phase 9: CI Hardening and Node Support Guarantees

**Purpose**: Establish CI matrix that proves Bun-first + Node-supported behavior.

**Scope**:

- CI configuration
- Test matrix
- Parity checks
- Release gating
- NOT: Removing Node support

**Tasks**:

1. Establish CI matrix (if CI exists) or create local validation script:
   - Primary job: All tests under Bun
   - Parity job: All tests under Node
   - Comparison: Compare results between jobs
   - Fail parity job if significant differences
2. Add performance benchmarks to CI:
   - CLI startup time under Bun
   - CLI startup time under Node
   - Fail if Bun > 1.5x Node time
3. Add integration test matrix:
   - Run integration tests under Bun
   - Run integration tests under Node
4. Add release gates:
   - Block release if Bun tests fail
   - Block release if Node parity fails
   - Block release if performance regression
5. Add Node support verification:
   - Periodic full test run on Node
   - Verify no Node-specific deprecations
   - Verify Node version compatibility
6. Document CI strategy
7. Create on-call runbook for CI failures

**Validation**:

- CI matrix running successfully
- Bun tests passing
- Node parity tests passing
- Performance benchmarks within limits
- Integration tests passing under both runtimes
- Release gates functional

**Exit criteria**:

- CI matrix established and running
- Bun tests passing consistently
- Node parity tests passing consistently
- Performance within limits
- Release gates functional
- Documentation complete

**Rollback triggers**:

- CI matrix cannot be established
- Bun tests consistently failing
- Node parity consistently failing
- Performance consistently out of spec
- Release gates blocking releases

**Deliverables**:

- CI matrix configuration
- Performance benchmarks
- Integration test matrix
- Release gates
- CI documentation
- On-call runbook

---

### Phase 10: Defaulting to Bun-First Workflows

**Purpose**: Make Bun the default for all workflows while maintaining Node support.

**Scope**:

- Update documentation to reflect Bun-first
- Update developer onboarding
- Update README
- NOT: Removing Node support or Node-compatible paths

**Tasks**:

1. Update README to recommend Bun installation
2. Update CONTRIBUTING.md with Bun-first instructions
3. Update developer onboarding docs
4. Update all documentation to reflect Bun-first with Node fallback
5. Add Bun installation instructions to getting started
6. Document Node support as compatibility guarantee
7. Update examples to use Bun commands
8. Add troubleshooting section for Bun issues
9. Announce Bun-first status to team
10. Create migration FAQ

**Validation**:

- Documentation updated consistently
- Bun-first message clear
- Node support still documented
- Examples work with Bun
- Troubleshooting section helpful

**Exit criteria**:

- All documentation updated
- Bun-first status clear
- Node support documented
- Examples validated
- Team notified

**Rollback triggers**: N/A (documentation only)

**Deliverables**:

- Updated README
- Updated CONTRIBUTING.md
- Updated onboarding docs
- Updated all documentation
- Bun installation instructions
- Node support documentation
- Troubleshooting section
- Migration FAQ

---

### Phase 11: Cleanup and Debt Removal

**Purpose**: Remove temporary migration code and optimize for Bun-first.

**Scope**:

- Remove temporary fallback wrappers where no longer needed
- Remove Node-specific code paths that are proven unnecessary
- Optimize for Bun performance
- NOT: Removing Node support or making Node incompatible

**Tasks**:

1. Identify temporary migration code:
   - Fallback wrappers that are never exercised
   - Node-specific code paths that are never hit
   - Temporary compatibility shims
2. Remove unused fallback wrappers
3. Remove unused Node-specific code paths
4. Optimize Bun-specific paths:
   - Use Bun-specific APIs where beneficial
   - Remove unnecessary abstractions
   - Optimize for Bun's performance characteristics
5. Update comments to reflect current state
6. Remove migration tracking documents (archive them)
7. Final documentation cleanup

**Validation**:

- Unused code removed
- Optimizations don't break Node compatibility
- Tests still pass under both runtimes
- Node support still functional

**Exit criteria**:

- Temporary migration code removed
- Unused Node-specific paths removed
- Bun optimizations in place
- Tests passing under both runtimes
- Node support verified
- Documentation cleaned up

**Rollback triggers**:

- Removal breaks Node compatibility
- Optimizations cause regressions
- Tests fail under Node

**Deliverables**:

- Cleaned codebase
- Optimized Bun paths
- Archived migration documents
- Final documentation

---

## F. Detailed Script Strategy

### Evolution of package.json Scripts

**Current state (Phase 0)**:

```json
{
  "scripts": {
    "build": "node esbuild.config.mjs",
    "test": "node scripts/test-projects.mjs",
    "dev": "node scripts/run-node.mjs"
  }
}
```

**After Phase 2 (Build scripts migrated)**:

```json
{
  "scripts": {
    "build": "node scripts/run-with-fallback.mjs -- node esbuild.config.mjs",
    "build:watch": "node scripts/run-with-fallback.mjs -- node esbuild.config.mjs --watch",
    "lint": "node scripts/run-with-fallback.mjs -- node scripts/run-oxlint.mjs"
  }
}
```

**After Phase 3 (Test runner migrated)**:

```json
{
  "scripts": {
    "test": "node scripts/run-test.mjs",
    "test:fast": "node scripts/run-test.mjs --config test/vitest/vitest.unit-fast.config.ts"
  }
}
```

**After Phase 4 (Runtime entrypoint migrated)**:

```json
{
  "scripts": {
    "dev": "node scripts/run-with-fallback.mjs -- node scripts/run-node.mjs",
    "start": "node scripts/run-with-fallback.mjs -- node scripts/run-node.mjs"
  }
}
```

**Final state (Phase 10+)**:

```json
{
  "scripts": {
    "build": "bun esbuild.config.mjs || node esbuild.config.mjs",
    "test": "bun scripts/run-test.mjs",
    "dev": "bun scripts/run-node.mjs || node scripts/run-node.mjs"
  }
}
```

### Naming Conventions for Transitional Scripts

- **Wrapper scripts**: `run-with-fallback.mjs`, `run-test.mjs` - generic names for runtime selection
- **Runtime-specific scripts**: `scripts/bun-*.mjs`, `scripts/node-*.mjs` - only if runtime-specific behavior needed
- **Comparison scripts**: `scripts/runtime-compare.mjs`, `scripts/bun-parity-check.mjs` - for validation
- **Avoid**: Script names like `dev:bun`, `test:bun` - these encourage parallel maintenance

### Coexistence Strategy

1. **Default path uses Bun**: Primary scripts prefer Bun
2. **Fallback explicit**: Fallback to Node is visible in script definition
3. **Env override**: `OPENCLAW_RUNTIME=node` forces Node for any script
4. **Logging**: All wrappers log which runtime is being used
5. **Documentation**: README explains Bun-first with Node fallback

### Avoiding Contributor Confusion

1. **Clear documentation**: README explains Bun-first approach
2. **Consistent patterns**: All scripts use same wrapper pattern
3. **Helpful errors**: If Bun not installed, error message explains how to install or fallback
4. **Logging**: Runtime choice is logged so contributors know what's happening
5. **Onboarding**: Contributor guide explains runtime strategy

### Preventing Node Support Rot

1. **CI parity job**: Node tests run in CI on every commit
2. **Performance gates**: Bun performance compared to Node, fail if regression
3. **Release gates**: Cannot release if Node tests fail
4. **Periodic full Node runs**: Weekly full test suite on Node
5. **Node version testing**: Test on multiple Node versions
6. **Deprecation monitoring**: Watch for Node API deprecations that affect codebase

---

## G. Detailed Test Strategy

### Unit Tests

**Migration approach**:

- Phase 3: Migrate test runner to Bun-first
- Run all unit tests under Bun by default
- Maintain Node unit test runs in CI for parity
- Fix Bun-specific issues with runtime detection, not by excluding tests

**Validation**:

- All unit tests pass under Bun
- All unit tests pass under Node (CI parity)
- Coverage identical between runtimes
- Timing within 20% tolerance

**Where not to force Bun immediately**:

- Tests that mock Node internals in Bun-incompatible ways
- Tests that require specific Node version features not in Bun
- Tests for subprocess abstraction (test both implementations separately)

### Integration Tests

**Migration approach**:

- Phase 6: After subprocess abstraction, run integration tests under Bun
- Maintain Node integration test runs in CI for parity
- Docker-based integration tests support both runtimes

**Validation**:

- Integration tests pass under Bun
- Integration tests pass under Node (CI parity)
- Behavior identical between runtimes

**Where not to force Bun immediately**:

- Tests that spawn Node-specific processes
- Tests that require Node debugger
- Tests for native dependency compatibility

### Subprocess Tests

**Migration approach**:

- Phase 5: Test abstraction layer under both runtimes
- Phase 6: After migration, tests verify abstraction behavior
- Separate tests for Node and Bun implementations

**Validation**:

- Abstraction layer tests pass under both runtimes
- Subprocess call tests pass under both runtimes
- Windows-specific tests pass under Bun (on Windows)

**Where not to force Bun immediately**:

- Tests for Node-specific child_process features not in Bun
- Tests for Windows cmd.exe behavior that Bun cannot match

### CLI Tests

**Migration approach**:

- Phase 4: Test CLI under both runtimes
- Test all major CLI commands under Bun and Node
- Compare CLI output and behavior

**Validation**:

- CLI tests pass under Bun
- CLI tests pass under Node (CI parity)
- CLI behavior identical between runtimes

**Where not to force Bun immediately**:

- Tests for CLI startup performance (benchmark both)
- Tests for CLI-specific Node features

### Regression Tests

**Migration approach**:

- Add Bun-specific regression tests for known Bun issues
- Maintain existing regression tests under Node
- Use runtime detection to skip Bun-inappropriate tests

**Validation**:

- Regression tests pass under appropriate runtime
- No regressions introduced by Bun migration

**Where not to force Bun immediately**:

- Regression tests for Node-specific bugs
- Regression tests for features not yet supported under Bun

### Compatibility Tests

**Migration approach**:

- Create compatibility test suite that runs under both runtimes
- Test runtime detection, fallback behavior, cross-runtime compatibility
- Verify Node support doesn't rot

**Validation**:

- Compatibility tests pass under both runtimes
- Fallback behavior works correctly
- Node support verified

**Where not to force Bun immediately**:

- N/A - compatibility tests should run under both runtimes by design

### Flaky Test Handling

**Strategy**:

- Identify flaky tests under Bun
- Use runtime detection to skip flaky tests under Bun with documentation
- Fix flaky tests if possible (timing issues, race conditions)
- Track flaky tests in migration document

**Process**:

1. Document flaky test with runtime and reason
2. Skip under Bun with `if (!isBun())` or similar
3. File issue for fixing the flakiness
4. Re-enable when fixed

---

## H. Detailed Build/Bundling Strategy

### What Stays as Plain TypeScript Execution

**Reason**: Runtime-agnostic, no bundling needed

- Library exports (`dist/index.js`)
- Plugin SDK exports (`dist/plugin-sdk/*.js`)
- Extension code (loaded dynamically by jiti)
- Type definitions (generated by tsc)

**Implementation**:

- Keep esbuild `bundle: false` for library/plugin-sdk
- Use TypeScript for type generation only
- No runtime-specific transpilation needed

### What Gets Bundled

**Reason**: Startup performance, single-file distribution

- CLI entrypoint (`openclaw.mjs`)
- Browser bundles (extension web UI)
- Some extension bundles (already using `bun build`)

**Implementation**:

- Keep esbuild bundling for CLI entry
- Target `node22` for compatibility with both runtimes
- Keep external dependencies external (sharp, aws-sdk, etc.)
- Use `bun build` for browser bundles where already in use

### What Gets Compiled Differently for Bun vs Node

**Reason**: Runtime-specific optimizations

- **None initially** - use same build artifacts for both runtimes
- **Phase 11 consideration**: If Bun-specific optimizations needed, create separate build targets

**Implementation**:

- Phase 0-10: Single build artifact for both runtimes
- Phase 11: Evaluate if Bun-specific builds provide value
- If Bun-specific builds: create `dist-bun/` with Bun-optimized output

### What Remains Node-Oriented for Compatibility

**Reason**: Node-specific features or dependencies

- Native dependency postinstall scripts (must run under Node)
- Some build scripts that require Node-specific tools
- Type generation (tsc is runtime-agnostic but ecosystem assumes Node)

**Implementation**:

- Keep native dependency builds under Node
- Use fallback wrapper for scripts that must run under Node
- Document why specific scripts require Node

### Evaluation Criteria

**Startup performance**:

- Benchmark CLI startup under both runtimes
- If Bun is significantly faster, consider Bun-specific optimizations
- Target: Bun startup ≤ 1.5x Node startup

**Output compatibility**:

- Build artifacts must run under both Node and Bun
- Verify with `node dist/index.js` and `bun dist/index.js`
- Test on multiple Node versions

**Sourcemaps**:

- Ensure sourcemaps work under both runtimes
- Test debugging under both runtimes
- Verify stack trace quality

**Debugging**:

- Test debugging under both runtimes
- Verify breakpoints work
- Verify inspector protocol compatibility

**Package exports**:

- Ensure package.json exports work under both runtimes
- Test subpath exports
- Test conditional exports (if any)

**Executable entrypoints**:

- Verify shebang works under both runtimes
- Test `./openclaw.mjs` execution
- Test npm global installation

---

## I. CI/CD Strategy

### Matrix Structure

**Primary matrix** (if CI exists):

```yaml
test-matrix:
  - runtime: [bun, node]
    node-version: [22]
    os: [ubuntu-latest, windows-latest, macos-latest]
  - runtime: [node]
    node-version: [20, 22]
    os: [ubuntu-latest]
```

**Jobs**:

1. **test-bun-primary**: Full test suite under Bun (main validation)
2. **test-node-parity**: Full test suite under Node (parity check)
3. **test-node-versions**: Test on Node 20, 22 (version compatibility)
4. **test-integration-bun**: Integration tests under Bun
5. **test-integration-node**: Integration tests under Node
6. **perf-benchmark**: CLI startup benchmark under both runtimes
7. **build-verify**: Build artifacts work under both runtimes

### What Runs on Bun

- Full test suite (primary)
- Integration tests (primary)
- Build verification
- Performance benchmarks
- Docker builds (if applicable)

### What Still Runs on Node

- Full test suite (parity job)
- Integration tests (parity job)
- Node version compatibility tests
- Native dependency builds
- Some build scripts that require Node

### Parity Checks

**Automated**:

- Compare test results between Bun and Node jobs
- Fail if test pass/fail status differs
- Fail if coverage differs by > 1%
- Compare performance benchmarks (fail if Bun > 1.5x Node)

**Manual**:

- Review parity job results weekly
- Investigate any persistent differences
- Document acceptable differences

### Failure Policy

**Bun test failures**:

- Block merge
- Must fix before proceeding
- Evaluate if Bun incompatibility or test issue

**Node parity failures**:

- Block merge if regression (previously passing)
- Allow merge if pre-existing issue (document in tracking)
- Must fix before Phase 10 (defaulting to Bun-first)

**Performance regressions**:

- Warning if Bun 1.2-1.5x slower
- Block if Bun > 1.5x slower
- Investigate and optimize

**Integration test failures**:

- Block merge
- Must fix regardless of runtime

### Release Gating

**Pre-release checks**:

1. All Bun tests passing
2. All Node parity tests passing
3. Performance within limits
4. Integration tests passing under both runtimes
5. Build artifacts verified under both runtimes
6. Docker containers verified under both runtimes

**Release checklist**:

- [ ] Bun test suite passes
- [ ] Node parity test suite passes
- [ ] Performance benchmarks green
- [ ] Integration tests pass under Bun
- [ ] Integration tests pass under Node
- [ ] Build artifacts work under both runtimes
- [ ] Documentation updated
- [ ] Migration tracking updated

### Preventing Node Support from Silently Breaking

**Automated guards**:

- Node parity job runs on every commit
- Failure blocks merge
- Weekly full Node test suite on all Node versions
- Monthly Node deprecation scan

**Manual checks**:

- Review Node parity results in release meetings
- Test release candidates under Node locally
- Monitor Node-specific issue reports

**Monitoring**:

- Track Node-specific bug reports
- Track Node version compatibility issues
- Track deprecation warnings from Node
- Quarterly Node support audit

---

## J. Repo Refactor Recommendations

### Required Now

1. **Runtime detection module** (`src/shared/runtime-detection.ts`)
   - Required for all subsequent phases
   - Single source of truth for runtime detection
   - Used by all wrappers and abstractions

2. **Subprocess abstraction layer** (`src/process/runtime-agnostic-exec.ts`)
   - Required before subprocess migration
   - Hides runtime differences
   - Enables dual-path execution

3. **Fallback wrapper script** (`scripts/run-with-fallback.mjs`)
   - Required for script migration
   - Provides consistent Bun-first with Node fallback
   - Used by all migrated scripts

4. **Test runner wrapper** (`scripts/run-test.mjs`)
   - Required for test migration
   - Enables Bun-first test execution with Node override
   - Consistent with other wrappers

### Recommended Soon

1. **Plugin loading runtime validation** (`src/plugins/runtime-validation.ts`)
   - Validates plugin loading under both runtimes
   - Catches plugin compatibility issues early
   - Enables safe plugin ecosystem migration

2. **Performance benchmark suite** (`scripts/perf-bench.mjs`)
   - Benchmarks critical operations under both runtimes
   - Tracks performance regressions
   - Informs optimization decisions

3. **CI parity comparison tool** (`scripts/compare-ci-results.mjs`)
   - Compares test results between runtimes
   - Automates parity checking
   - Reduces manual review burden

### Optional Later

1. **Bun-specific optimization module** (`src/shared/bun-optimizations.ts`)
   - Bun-specific optimizations for performance
   - Only after Bun is default and stable
   - Phase 11 cleanup

2. **Migration tracking dashboard** (internal tool)
   - Tracks migration progress
   - Visualizes parity metrics
   - Helps with communication

3. **Automated fallback testing** (`scripts/test-fallbacks.mjs`)
   - Tests that fallback paths work
   - Ensures Node support doesn't rot
   - Periodic validation

---

## K. Anti-Patterns to Avoid

1. **Replacing scripts before parity exists**
   - Do not replace `node script.mjs` with `bun script.mjs` without testing both
   - Always use fallback wrapper initially
   - Prove parity before removing fallback

2. **Assuming Bun test coverage equals Node behavior coverage**
   - Passing tests under Bun does not prove identical behavior
   - Must run tests under both runtimes and compare results
   - Integration tests especially critical

3. **Hiding compatibility gaps behind undocumented env flags**
   - Do not use env flags to silently switch behavior
   - Document all runtime-specific behavior
   - Use runtime detection, not hidden flags

4. **Switching runtime and test runner in the same phase**
   - Makes debugging difficult
   - Cannot isolate which change caused failure
   - Separate phases for runtime and test runner

5. **Removing Node-compatible code paths prematurely**
   - Keep Node paths until CI proves Bun equivalence
   - Phase 11 is for cleanup, not earlier phases
   - Node support is a guarantee, not temporary

6. **Assuming Bun compatibility is perfect**
   - Bun has known incompatibilities
   - Test everything, assume nothing
   - Document all Bun-specific workarounds

7. **Forcing Bun into places where it adds risk without gain**
   - If a script works fine under Node and Bun provides no benefit, keep it under Node
   - Migration should be pragmatic, not ideological
   - Focus on high-leverage areas first

8. **Ignoring Windows-specific behavior**
   - Windows subprocess behavior is complex
   - Bun may not match Node exactly
   - Test thoroughly on Windows

9. **Breaking the plugin ecosystem**
   - Extensions must work under both runtimes
   - Do not introduce Bun-specific extension APIs
   - Test extension compatibility early

10. **Silent fallback without logging**
    - Always log which runtime is being used
    - Make fallback behavior visible
    - Helps debugging and understanding

11. **Big bang migration**
    - Do not try to migrate everything at once
    - Incremental phases with validation
    - Ability to rollback at each phase

12. **Treating Node support as temporary**
    - Node support is a first-class compatibility guarantee
    - Not a legacy feature to be removed
    - Maintain it indefinitely

---

## L. Final Recommended Migration Order

1. **Phase 0: Discovery and Baseline**
   - Complete audit checklist
   - Catalog native dependencies
   - Establish test baseline
   - Document all findings

2. **Phase 1: Compatibility Scaffolding**
   - Add Bun to devDependencies
   - Create runtime detection utilities
   - Create comparison tools
   - Establish CI matrix

3. **Phase 2: Script Migration (Build and Tooling)**
   - Create fallback wrapper
   - Migrate build scripts one-by-one
   - Migrate lint scripts
   - Migrate code generation scripts
   - Validate each migration

4. **Phase 3: Test Runner Migration**
   - Audit vitest configs
   - Create test runner wrapper
   - Update test scripts
   - Fix failing tests
   - Validate parity

5. **Phase 4: Runtime Entrypoint Migration**
   - Audit entry.ts and openclaw.mjs
   - Create runtime-aware entrypoint
   - Update CLI scripts
   - Validate CLI under both runtimes

6. **Phase 5: Subprocess Abstraction**
   - Design abstraction interface
   - Implement Node implementation
   - Implement Bun implementation
   - Test under both runtimes

7. **Phase 6: Subprocess Call Migration**
   - Catalog subprocess calls
   - Migrate calls in priority order
   - Validate each migration
   - Run full test suite

8. **Phase 7: Plugin Loading Validation**
   - Test plugin loading under Bun
   - Test jiti under Bun
   - Test plugin SDK resolution
   - Implement workarounds if needed

9. **Phase 8: Docker and Container Migration**
   - Audit Dockerfiles
   - Add Bun to containers
   - Create runtime detection
   - Validate containers

10. **Phase 9: CI Hardening and Node Support Guarantees**
    - Establish CI matrix
    - Add performance benchmarks
    - Add release gates
    - Create on-call runbook

11. **Phase 10: Defaulting to Bun-First Workflows**
    - Update README
    - Update CONTRIBUTING.md
    - Update all documentation
    - Announce to team

12. **Phase 11: Cleanup and Debt Removal**
    - Remove temporary wrappers
    - Remove unused Node paths
    - Optimize for Bun
    - Final documentation cleanup

**Estimated timeline**: 8-12 weeks assuming dedicated focus, longer if part-time

**Critical path**: Phase 0 → 1 → 2 → 5 → 6 → 9 (build, subprocess, CI are foundational)

**Parallelizable**: Phase 3 can overlap with Phase 4-5, Phase 7 can overlap with Phase 8

**Success criteria**:

- Bun is default runtime for all workflows
- Node support remains fully functional
- CI proves parity on every commit
- Performance within acceptable limits
- Documentation complete and accurate
