@AGENTS.md

## Automated Hook & Quality Gate Instructions

- **Handling Stop/PreToolUse Hook Failures:**
  If a hook blocks execution or fails (e.g., lint, typecheck, or build errors injected by a Stop or PreToolUse hook):
  1. **Do not stop or give up.** Treat the hook output as an active requirement.
  2. **Read the errors carefully** from the hook output to identify broken files, lines, or missing types.
  3. **Fix the issues** in the code directly.
  4. **Re-run verification commands** (`npm run lint`, `npm run typecheck`, `npm run build`) manually to confirm the fixes.
  5. **Attempt completion / push again** only after all checks pass cleanly with zero errors.