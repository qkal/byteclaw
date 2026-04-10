# Git Workflow for OpenClaw Project

## Important: Use Git Frequently

**Always commit your work before ending a session.** This ensures your changes are saved and provides a clear history of your work.

## Git Best Practices for OpenClaw

### Commit Frequency

- Commit after completing each logical task or feature
- Commit before switching to a different task
- Commit at least every 30-60 minutes during active development
- Never leave uncommitted work at the end of a session

### Commit Message Format

Use clear, descriptive commit messages:

```
<type>: <short description>

<optional longer description>
```

Types:

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation changes
- `style:` Code style changes (formatting, etc.)
- `refactor:` Code refactoring
- `test:` Adding or updating tests
- `chore:` Maintenance tasks
- `ci:` CI/CD changes

Examples:

```
feat: add oxlint linting to project
fix: resolve variable redeclaration errors in catch blocks
docs: update git workflow documentation
```

### Branching Strategy

- `main` - Stable, production-ready code
- Feature branches - `feature/short-description` for new features
- Bugfix branches - `fix/short-description` for bug fixes
- Never commit directly to main for experimental changes

### Before Committing

1. Run linting: `pnpm lint`
2. Run tests: `pnpm test` (if applicable)
3. Review your changes: `git diff --staged`
4. Ensure no sensitive data is committed (check `.gitignore`)

### Common Git Commands

**Check status:**

```bash
git status
```

**Stage changes:**

```bash
git add .                    # Stage all changes
git add <file>               # Stage specific file
git add -p <file>            # Stage changes interactively
```

**Commit:**

```bash
git commit -m "feat: add new feature"
```

**View history:**

```bash
git log --oneline           # Compact history
git log --graph --oneline   # Visual branch history
```

**Undo changes:**

```bash
git checkout -- <file>      # Discard unstaged changes
git reset HEAD <file>       # Unstage changes
git reset --soft HEAD~1     # Undo last commit, keep changes
git reset --hard HEAD~1     # Undo last commit, discard changes
```

**Branch operations:**

```bash
git branch <name>           # Create branch
git checkout <name>         # Switch branch
git checkout -b <name>      # Create and switch branch
git branch -d <name>        # Delete branch
```

### Project-Specific Notes

**Ignored Files:**

- `.oxlintrc.jsonc` - Linting configuration (local preferences)
- `node_modules/` - Dependencies
- `dist/` - Build outputs
- `.env` - Environment variables (contains secrets)
- `.agent/` - Agent credentials and memory (NEVER commit)
- `coverage/` - Test coverage reports

**Large Binary Files:**
If you need to commit large binary files, consider using Git LFS or storing them externally.

**Merge Conflicts:**
When resolving conflicts, carefully review both sides and test the merged code before committing.

### Session Checklist

Before ending a session:

- [ ] Run `git status` to see uncommitted changes
- [ ] Stage and commit all important work
- [ ] Run `pnpm lint` to ensure code quality
- [ ] Run tests if you made code changes
- [ ] Push to remote if working with a team
- [ ] Document any work-in-progress in a comment or TODO

### CI/CD Integration

The project uses:

- No GitHub Actions currently configured
- Manual testing and validation required before merging
- Consider adding CI in the future for automated testing
