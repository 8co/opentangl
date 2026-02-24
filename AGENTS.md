# AGENTS.MD - OpenTangl

## Project

- **Purpose:** Autonomous AI development engine for continuous full-stack development
- **Stack:** TypeScript, Node.js
- **License:** MIT

## First-Time Users

If the user is setting up OpenTangl for the first time or asks "how do I get started," follow the instructions in `.cursor/rules/getting-started.md`. That file contains the full onboarding flow — project detection, config generation, vision doc creation, and first run.

## Conventions (for contributors)

### Code Style

- TypeScript strict mode, always
- ES2022+ syntax (async/await, optional chaining, nullish coalescing)
- Functional over class-based unless state management requires it
- No default exports — use named exports
- Error handling: try/catch with typed errors, never swallow silently

### Naming

- Files: kebab-case (`workflow-manager.ts`)
- Functions/variables: camelCase
- Types/interfaces: PascalCase
- Constants: UPPER_SNAKE_CASE

### Infrastructure

- Environment variables for configuration (`.env`)
- CLI-first — all operations available via `npx tsx src/cli.ts`

## Rules for Agents

1. **Read before writing.** Explore relevant files and docs before making changes.
2. **Match existing patterns.** Look at how similar things are already done in the codebase.
3. **Don't create documentation unless asked.** No README.md, no CHANGELOG, no markdown files unless explicitly requested.
4. **Commit messages are imperative.** "Add feature" not "Added feature" or "Adding feature".
5. **Test locally first.** Verify with CLI before deploying to cloud.
6. **Keep it simple.** One model setting, one approach. Don't over-engineer.
7. **CLI first.** Start with a CLI that can verify output directly.
8. **Write docs to docs/.** When asked to document, write to the project's docs/ folder. Let the model pick the filename.
9. **Short prompts work.** Don't pad responses. Be direct.
10. **When stuck, read more code.** Don't guess — search the codebase.

## Context Loading

Run `npm run docs:list` to see available documentation.
Run `npm run docs:cat` to read all project docs before starting work.
