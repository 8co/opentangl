# Copilot Instructions — OpenTangl

OpenTangl is an autonomous development engine. It uses LLMs to propose, execute, review, and merge development tasks across one or more JS/TS codebases.

## First-Time Setup

If the user is setting up OpenTangl for the first time or asks how to get started, read and follow the full onboarding guide at `.cursor/rules/getting-started.md`. That file walks through:

1. Prerequisites check (Node.js, git, gh CLI, API key)
2. Project type detection (new project, existing codebase, or unknown)
3. Config generation (`projects.yaml`, `.env`)
4. Vision doc creation (`docs/environments/{name}/product-vision.md`)
5. First autopilot run

## Contributing

### Code Style
- TypeScript strict mode
- ES2022+ syntax (async/await, optional chaining, nullish coalescing)
- Named exports only — no default exports
- Error handling: try/catch with typed errors, never swallow silently
- Files: kebab-case, functions: camelCase, types: PascalCase, constants: UPPER_SNAKE_CASE

### Rules
1. Read before writing. Explore relevant files before making changes.
2. Match existing patterns in the codebase.
3. Commit messages are imperative: "Add feature" not "Added feature."
4. Keep it simple. Don't over-engineer.
5. When stuck, read more code — don't guess.

### Key Directories
- `src/` — OpenTangl source code
- `prompts/` — LLM prompt templates
- `docs/` — documentation and environment configs
- `examples/` — example config files for new users
- `tasks/` — task queue (auto-managed, don't edit by hand)
