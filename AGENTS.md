<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Git & Pull Request Workflow
- **NEVER** push or commit directly to the `main` branch.
- For **EVERY** code modification, bug fix, or feature build:
  1. Create a new git feature branch with a descriptive name.
  2. Stage and commit the changes atomically.
  3. Push the branch to remote.
  4. Create a Pull Request.
- Do not consider a task complete until the PR has been opened and the PR URL is provided.