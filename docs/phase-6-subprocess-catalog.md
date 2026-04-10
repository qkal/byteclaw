# Phase 6: Subprocess Call Migration Catalog

**Total Files Using node:child_process:** 93 files
**Total Files Using require('child_process'):** 3 files

## High Priority Files (Core Infrastructure)

1. `src/process/exec.ts` - Main subprocess utility with Windows handling
2. `src/process/spawn-utils.ts` - Spawn utilities
3. `src/process/child-process-bridge.ts` - Child process bridge
4. `src/process/kill-tree.ts` - Process tree killing
5. `src/entry.ts` - CLI entry point
6. `src/infra/process-respawn.ts` - Process respawn handling

## Medium Priority Files (Frequently Used)

7. `src/agents/bash-process-registry.ts` - Bash process registry
8. `src/infra/gateway-processes.ts` - Gateway process management
9. `src/infra/restart.ts` - Restart handling
10. `src/infra/ssh-tunnel.ts` - SSH tunneling
11. `src/infra/ssh-config.ts` - SSH configuration
12. `src/cli/container-target.ts` - CLI container targeting

## Low Priority Files (Tests and E2E)

- All test files (*.test.ts)
- E2E test files
- Integration tests

## Migration Strategy

Given the large number of files (93), the migration should be done incrementally:

1. **Phase 6a**: Migrate core infrastructure files (6 files)
2. **Phase 6b**: Migrate frequently used files (6 files)
3. **Phase 6c**: Migrate remaining files (81 files) - can be done gradually

## Notes

- The `src/process/exec.ts` file contains extensive Windows-specific handling that must be preserved
- Some files may need special handling due to complex subprocess interactions
- Test files can be migrated last since they don't affect runtime behavior
