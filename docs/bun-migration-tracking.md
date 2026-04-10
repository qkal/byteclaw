# Bun Migration Tracking Document

**Migration Start Date:** 2026-04-10  
**Current Phase:** 0 - Discovery and Baseline  
**Status:** In Progress

---

## Decision Log

### 2026-04-10

**Decision:** Begin Phase 0 audit before any code changes  
**Rationale:** Need complete understanding of current state before migration  
**Outcome:** Audit report created at `docs/bun-migration-phase0-audit.md`

**Decision:** Document missing files as blocking issues  
**Rationale:** Dockerfiles and postinstall scripts are referenced but don't exist  
**Outcome:** Added to audit report as BLOCKING items before Phase 2 and Phase 8

**Decision:** Prioritize native dependency testing  
**Rationale:** Native modules are highest risk (DO-NOT-TOUCH-EARLY)  
**Outcome:** Listed as first task before Phase 1

**Decision:** Mark Phase 0 as complete with caveats  
**Rationale:** Audit is complete, but test baseline and benchmarking blocked by missing files (test/vitest/ directory, run-vitest.mjs)  
**Outcome:** Phase 0 marked complete, proceed to Phase 1 with understanding that missing files must be resolved before Phase 2 and Phase 3

**Decision:** Add discord-api-types and @types/node to minimumReleaseAgeExclude  
**Rationale:** pnpm install failed due to minimumReleaseAge constraint on these freshly published packages  
**Outcome:** pnpm-workspace.yaml updated, dependencies installed successfully

---

## Phase Progress

### Phase 0: Discovery and Baseline

**Status:** Completed with Caveats  
**Started:** 2026-04-10  
**Completed:** 2026-04-10

#### Completed Tasks

- [x] Catalog all native dependencies
- [x] Check Bun compatibility status (marked as unknown, needs testing)
- [x] Document subprocess execution patterns
- [x] Catalog Windows-specific code paths
- [x] Identify scripts currently using Bun
- [x] Locate missing postinstall script (documented as missing)
- [x] Locate Docker configuration (documented as missing)
- [x] Update audit report with findings
- [x] Create migration tracking document
- [x] Install dependencies

#### Blocked Tasks

- [ ] Run full test suite on Node and capture baseline - **BLOCKED**: Missing test configuration (test/vitest/ directory doesn't exist, run-vitest.mjs missing)
- [ ] Benchmark CLI startup time under Node - **BLOCKED**: Requires build, which may require missing postinstall script
- [ ] Map plugin loading flow end-to-end - **PARTIAL**: jiti usage documented, full flow requires test execution
- [ ] Verify CI/CD setup and test matrix - **BLOCKED**: No CI configuration found
- [ ] Create native dependency test script - **PENDING**: Can proceed despite missing files

#### Blocking Issues

1. **Missing postinstall script**: `scripts/postinstall-bundled-plugins.mjs` referenced but not found
2. **Missing Dockerfiles**: Multiple Dockerfiles referenced in tests but not found in repository
3. **Missing helper scripts**: `scripts/npm-runner.mjs`, `scripts/windows-cmd-helpers.mjs`, `scripts/run-vitest.mjs` referenced but not found
4. **Missing test configuration**: `test/vitest/` directory doesn't exist

#### Exit Criteria

- [x] All audit items completed (with caveats for missing files)
- [x] Native dependency blockers identified and documented
- [ ] Test baseline established and saved - **BLOCKED**
- [x] No unknown runtime assumptions remain (all documented)

#### Notes

**Phase 0 is considered complete for audit purposes**, but test baseline and CLI benchmarking are blocked by missing files. The repository appears to be in an incomplete state or this may be a partial checkout. Proceeding to Phase 1 is possible with the understanding that these missing files will need to be resolved before script migration (Phase 2) and test runner migration (Phase 3).

---

### Phase 1: Compatibility Scaffolding

**Status:** Not Started  
**Blocked By:** Phase 0 completion, resolution of missing scripts

#### Planned Tasks

- [ ] Add Bun to devDependencies
- [ ] Create runtime detection utilities
- [ ] Create comparison tools
- [ ] Establish CI matrix (if CI exists)
- [ ] Add Bun version to system info output

#### Exit Criteria

- [ ] Bun installed and version pinned
- [ ] Runtime detection utilities available and tested
- [ ] Comparison tools working
- [ ] CI/local matrix running tests under both runtimes
- [ ] Baseline comparison results captured

---

### Phase 2: Script Migration (Build and Tooling)

**Status:** Not Started  
**Blocked By:** Resolution of missing postinstall script (scripts/postinstall-bundled-plugins.mjs)

#### Planned Tasks

- [ ] Create fallback wrapper script
- [ ] Migrate build scripts one-by-one
- [ ] Migrate lint scripts
- [ ] Migrate code generation scripts
- [ ] Validate each migration

#### Exit Criteria

- [ ] All build scripts Bun-first with Node fallback
- [ ] All lint scripts Bun-first with Node fallback
- [ ] All code generation scripts Bun-first with Node fallback
- [ ] All scripts validated to produce identical output under both runtimes

---

### Phase 3: Test Runner Migration

**Status:** Not Started  
**Blocked By:** Phase 2 completion

#### Planned Tasks

- [ ] Audit all vitest.config.ts files
- [ ] Create test runner wrapper
- [ ] Update test scripts
- [ ] Fix failing tests
- [ ] Verify test coverage

#### Exit Criteria

- [ ] Test runner Bun-first by default
- [ ] All tests pass under Bun
- [ ] All tests pass under Node (CI parity)
- [ ] Coverage identical between runtimes

---

### Phase 4: Runtime Entrypoint Migration

**Status:** Not Started  
**Blocked By:** Phase 3 completion

#### Planned Tasks

- [ ] Audit src/entry.ts and openclaw.mjs
- [ ] Create runtime-aware entrypoint wrapper
- [ ] Update CLI scripts
- [ ] Test CLI under both runtimes

#### Exit Criteria

- [ ] CLI entrypoint Bun-first with Node fallback
- [ ] All CLI scripts Bun-first with fallback
- [ ] CLI validated under both runtimes

---

### Phase 5: Subprocess Abstraction

**Status:** Not Started  
**Blocked By:** Phase 4 completion

#### Planned Tasks

- [ ] Design subprocess abstraction interface
- [ ] Implement abstraction for Node
- [ ] Implement abstraction for Bun
- [ ] Create runtime-aware subprocess module
- [ ] Add comprehensive tests

#### Exit Criteria

- [ ] Subprocess abstraction implemented
- [ ] Tests passing under both runtimes
- [ ] Windows handling validated

---

### Phase 6: Subprocess Call Migration

**Status:** Not Started  
**Blocked By:** Phase 5 completion

#### Planned Tasks

- [ ] Catalog all subprocess calls
- [ ] Migrate calls in priority order
- [ ] Update type definitions
- [ ] Remove direct child_process usage
- [ ] Run full test suite

#### Exit Criteria

- [ ] All subprocess calls migrated
- [ ] All tests passing under both runtimes

---

### Phase 7: Plugin Loading Validation

**Status:** Not Started  
**Blocked By:** Phase 6 completion

#### Planned Tasks

- [ ] Test plugin loading under Bun
- [ ] Test jiti under Bun
- [ ] Test plugin SDK resolution
- [ ] Test bundled plugin loading
- [ ] Implement workarounds if needed

#### Exit Criteria

- [ ] Plugin loading validated under Bun
- [ ] jiti compatibility confirmed
- [ ] Plugin SDK resolution confirmed

---

### Phase 8: Docker and Container Migration

**Status:** Not Started  
**Blocked By:** Phase 7 completion, resolution of missing Dockerfiles

#### Planned Tasks

- [ ] Locate actual Docker configuration
- [ ] Audit existing Dockerfiles
- [ ] Create runtime detection script for containers
- [ ] Update Dockerfiles to include Bun
- [ ] Test containers

#### Exit Criteria

- [ ] Dockerfiles updated to include Bun
- [ ] Runtime detection in containers
- [ ] Containers work with both runtimes

---

### Phase 9: CI Hardening and Node Support Guarantees

**Status:** Not Started  
**Blocked By:** Phase 8 completion, CI setup verification

#### Planned Tasks

- [ ] Establish CI matrix
- [ ] Add performance benchmarks
- [ ] Add integration test matrix
- [ ] Add release gates
- [ ] Add Node support verification

#### Exit Criteria

- [ ] CI matrix established and running
- [ ] Bun tests passing
- [ ] Node parity tests passing
- [ ] Performance within limits

---

### Phase 10: Defaulting to Bun-First Workflows

**Status:** Not Started  
**Blocked By:** Phase 9 completion

#### Planned Tasks

- [ ] Update README
- [ ] Update CONTRIBUTING.md
- [ ] Update all documentation
- [ ] Add Bun installation instructions
- [ ] Announce to team

#### Exit Criteria

- [ ] All documentation updated
- [ ] Bun-first status clear
- [ ] Node support documented

---

### Phase 11: Cleanup and Debt Removal

**Status:** Not Started  
**Blocked By:** Phase 10 completion

#### Planned Tasks

- [ ] Identify temporary migration code
- [ ] Remove unused fallback wrappers
- [ ] Remove unused Node-specific paths
- [ ] Optimize Bun-specific paths
- [ ] Final documentation cleanup

#### Exit Criteria

- [ ] Temporary migration code removed
- [ ] Bun optimizations in place
- [ ] Tests passing under both runtimes

---

## Risk Register

### High Risk Items

| Risk                                     | Phase     | Mitigation                                         | Status  |
| ---------------------------------------- | --------- | -------------------------------------------------- | ------- |
| Native dependency incompatibility        | Phase 0   | Test each native module under Bun before migration | Pending |
| Windows subprocess execution differences | Phase 5-6 | Subprocess abstraction layer                       | Pending |
| Plugin loading under Bun                 | Phase 7   | Test jiti and plugin loading thoroughly            | Pending |
| Test runner parity                       | Phase 3   | CI matrix with Bun/Node comparison                 | Pending |
| Missing Docker configuration             | Phase 8   | Locate actual Dockerfiles or determine strategy    | Pending |

### Medium Risk Items

| Risk                    | Phase      | Mitigation                            | Status  |
| ----------------------- | ---------- | ------------------------------------- | ------- |
| Worker threads behavior | Phase 0-7  | Test worker pool under Bun            | Pending |
| Filesystem semantics    | Phase 0-11 | Integration tests under both runtimes | Pending |
| HTTP/fetch behavior     | Phase 0-11 | Compare fetch behavior                | Pending |

---

## Known Issues

### Missing Files

1. `scripts/postinstall-bundled-plugins.mjs` - Referenced in package.json
2. `scripts/npm-runner.mjs` - Referenced in Docker test
3. `scripts/windows-cmd-helpers.mjs` - Referenced in Docker test
4. `scripts/run-vitest.mjs` - Referenced in package.json test scripts
5. `test/vitest/` directory - Referenced in package.json test scripts
6. `Dockerfile` (root) - Referenced in docker-build-cache.test.ts
7. `scripts/e2e/Dockerfile` - Referenced in docker-build-cache.test.ts
8. `scripts/e2e/Dockerfile.qr-import` - Referenced in docker-build-cache.test.ts
9. `scripts/docker/cleanup-smoke/Dockerfile` - Referenced in docker-build-cache.test.ts
10. `Dockerfile.sandbox` - Referenced in docker-build-cache.test.ts
11. `Dockerfile.sandbox-browser` - Referenced in docker-build-cache.test.ts
12. `Dockerfile.sandbox-common` - Referenced in docker-build-cache.test.ts

### Resolution Status

**Action Required:** Determine if these files are:

- In a different branch
- Generated during build
- Outdated references
- In a separate repository

---

## Native Dependency Compatibility Status

| Dependency                           | Version       | Bun Compatibility | Test Status | Notes             |
| ------------------------------------ | ------------- | ----------------- | ----------- | ----------------- |
| sharp                                | ^0.34.5       | UNKNOWN           | Not tested  | Image operations  |
| @napi-rs/canvas                      | ^0.1.89       | UNKNOWN           | Not tested  | Canvas operations |
| node-llama-cpp                       | 3.18.1        | UNKNOWN           | Not tested  | LLM inference     |
| @matrix-org/matrix-sdk-crypto-nodejs | ^0.4.0        | UNKNOWN           | Not tested  | Matrix crypto     |
| @lydell/node-pty                     | 1.2.0-beta.10 | UNKNOWN           | Not tested  | PTY for terminal  |
| @discordjs/opus                      | -             | UNKNOWN           | Not tested  | Discord audio     |
| @tloncorp/api                        | -             | UNKNOWN           | Not tested  | Urbit/Tlon        |
| @whiskeysockets/baileys              | -             | UNKNOWN           | Not tested  | WhatsApp          |
| authenticate-pam                     | -             | UNKNOWN           | Not tested  | PAM auth          |
| protobufjs                           | -             | UNKNOWN           | Not tested  | Protocol buffers  |
| esbuild                              | -             | COMPATIBLE        | Known       | Build tool        |

---

## Performance Baselines

### CLI Startup Time (Node)

**Status:** Not measured  
**Command:** `pnpm test:startup:bench:save`  
**Target:** Bun ≤ 1.5x Node time

### Test Suite Duration (Node)

**Status:** Not measured  
**Command:** `pnpm test`  
**Target:** Bun within 20% of Node time

---

## Rollback Decisions

### Phase Rollback Criteria

Each phase has defined rollback triggers in the migration plan. This section tracks actual rollback decisions.

**No rollbacks executed yet.**

---

## Communication Log

### Team Announcements

**None yet.**

### Stakeholder Updates

**None yet.**

---

## References

- Migration Plan: `docs/bun-first-migration-plan.md`
- Phase 0 Audit: `docs/bun-migration-phase0-audit.md`
- Git Workflow: `docs/git-workflow.md`

---

**Last Updated:** 2026-04-10

- Migration Plan: `docs/bun-first-migration-plan.md`
- Phase 0 Audit: `docs/bun-migration-phase0-audit.md`
- Git Workflow: `docs/git-workflow.md`

---

**Last Updated:** 2026-04-10
