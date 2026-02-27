# OpenTangl — ClawHub Skill

Autonomous AI development engine that manages multiple repos as a single product. Point it at your codebase, write a product vision, and let it build.

## What It Does

This skill walks you through setting up OpenTangl from scratch:

1. **Detects your project** — scans your codebase to identify framework, build tools, and source structure
2. **Generates configuration** — creates `projects.yaml` and a product vision doc tailored to your project
3. **Configures the LLM** — sets up OpenAI or Anthropic as the AI provider
4. **Runs the first cycle** — kicks off an autonomous development loop that proposes tasks, writes code, verifies builds, creates PRs, and merges

## Requirements

- **Node.js** >= 18
- **git** with a configured remote
- **GitHub CLI** (`gh`) authenticated
- **LLM API key** — either `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`

## What Happens During a Cycle

```
Vision doc → Task proposal → Code generation → Build verification → PR creation → LLM review → Merge
```

Each cycle is a closed loop. OpenTangl reads your priorities, writes code to fulfill them, makes sure it compiles, and ships it — then updates the vision doc with progress.

## Multi-Repo Support

OpenTangl manages multiple repos as a single product. Define an environment in `projects.yaml` and it coordinates cross-project task ordering with `depends_on` — API changes land before the frontend code that consumes them.

## Links

- [Repository](https://github.com/8co/opentangl)
- [Getting Started Guide](https://github.com/8co/opentangl#getting-started)
- [Issues](https://github.com/8co/opentangl/issues)
