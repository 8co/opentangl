# Getting Started — OpenTangl

When a user asks how to get started, set up a project, or run OpenTangl for the first time, follow this guide. Your job is to walk them through setup conversationally — ask questions, detect what you can, and generate the config files they need.

## Prerequisites Check

Before anything else, verify these are installed. Check silently — only mention what's missing.

- **Node.js** ≥ 18 (`node --version`)
- **git** configured with a remote (`git --version`)
- **GitHub CLI** authenticated (`gh auth status`) — needed for PR creation and merging
- An **LLM API key** (OpenAI or Anthropic) — they'll provide this

If anything is missing, tell them exactly how to install it and stop until it's resolved.

## Step 1 — What Are We Working With?

Ask the user:

> Are you **(a)** building something new from scratch, **(b)** improving an existing project, or **(c)** not sure / something else?

### Path A: New Project

1. Ask: **"What do you want to build?"** Get a 2-3 sentence description. This becomes the seed for the vision doc.
2. Ask: **"What type of app is this?"** Offer options or infer from their description:
   - Frontend (React, Next.js, Vue)
   - API / Backend (Serverless, Express, Fastify)
   - Full-stack (both — this becomes a multi-project setup)
3. Scaffold the project using standard tooling. Run the appropriate command:
   - React + Vite: `npm create vite@latest {name} -- --template react-ts`
   - Next.js: `npx create-next-app@latest {name} --typescript`
   - Serverless: `npx serverless create --template aws-nodejs --path {name}`
   - Express: create `package.json` + `src/index.ts` manually
4. Initialize git if not already: `git init && git add . && git commit -m "Initial scaffold"`
5. Create a GitHub repo: `gh repo create {name} --public --source . --push`
6. Proceed to **Step 2** with the path(s) to the new project(s).

For **full-stack**: scaffold both projects (API + UI) as sibling directories, then register each separately in Step 2.

### Path B: Existing Project

1. Ask: **"Where is your project?"** Accept a relative or absolute path. If they say "right here" or "this directory," use the current working directory.
2. Scan the project root to auto-detect:
   - **Type**: Check for `tsconfig.json` (TypeScript), `vite.config.ts` (Vite), `next.config.*` (Next.js), `serverless.yml` (Serverless), `package.json` (Node.js)
   - **Package manager**: `package-lock.json` → npm, `yarn.lock` → yarn, `pnpm-lock.yaml` → pnpm
   - **Build/test commands**: Read `package.json` scripts — look for `build`, `test`, `lint`, `typecheck`
   - **Source directories**: Default to `src/` if it exists
   - **Target branch**: Run `git symbolic-ref refs/remotes/origin/HEAD` or check for `main` vs `master`
   - **Framework details**: Read `package.json` dependencies to identify React, Vue, Express, etc.
3. Present what you detected and ask if it looks right.
4. If they have **multiple related repos** (e.g., API + frontend), ask: "Are there other repos that are part of this same product?" Repeat detection for each.
5. Proceed to **Step 2**.

### Path C: Not Sure / Something Else

1. Ask them to describe their situation.
2. Explore the filesystem — list directories, read config files, check git status.
3. Based on what you find, route them to Path A or Path B.
4. If the project uses a language other than JavaScript/TypeScript, let them know: "OpenTangl currently supports JS/TS projects. Support for other languages is on the roadmap." Don't block them — they can still use it for parts that are JS/TS.

## Step 2 — Generate projects.yaml

Using the information gathered, create `projects.yaml` at the OpenTangl root. Use the template in `examples/projects.yaml.example` as reference.

**Required fields for each project:**
- `id`: short kebab-case identifier (e.g., `my-api`, `my-frontend`)
- `name`: human-readable name (usually the repo/directory name)
- `path`: relative path from the OpenTangl root to the project (e.g., `../my-app`)
- `type`: one of `typescript-node`, `serverless-js`, `serverless-ts`, `react-vite`, `react-next`, or a descriptive string
- `scan_dirs`: directories containing source code (usually `['src']`)

**Auto-populated with smart defaults:**
- `skip_patterns`: `['node_modules', 'dist', '*.test.*']` plus framework-specific patterns
- `verify`: derived from `package.json` scripts (build → verify, test → verify)
- `package_manager`: detected from lock file
- `merge.target_branch`: detected from git

**Optional — skip unless the user mentions them:**
- `sensitive_files`: files the AI should never modify (auth, config, infrastructure)
- `import_rules`: library-specific rules (version constraints, API patterns)
- `reference_context`: cross-project file references
- `description`: populated from the user's project description

**For multi-project setups**, group related projects under the same `environment` field (e.g., `environment: my-saas`). This links them to a shared product vision.

## Step 3 — Set Up the Vision Doc

Create `docs/environments/{environment}/product-vision.md` using the template in `examples/product-vision.md.template`.

**For new projects (Path A):**
- Take the user's description from Step 1 and expand it into the "Origin & Direction" section.
- Ask: "What are the first 3-5 things you want built?" This becomes the initial Active Initiatives.
- The user writes the Origin section. OpenTangl will maintain the Current Priorities section after each run.

**For existing projects (Path B):**
- Ask: "What's the next set of improvements you want? What's the product direction?"
- Help them articulate 3-5 priorities.
- If they're unsure, suggest: "I can scan the codebase and suggest what might need work — tests, refactoring, missing features."

The vision doc has two sections:
1. **Origin & Direction** — human-authored, never modified by OpenTangl. This is the north star.
2. **Current Priorities** — maintained by OpenTangl after each run. Start with initial priorities; the autopilot updates it.

## Step 4 — Configure the LLM

Create or update `.env` in the OpenTangl root from `.env.example`:

1. Ask: **"Which AI provider do you want to use — OpenAI or Anthropic (Claude)?"**
2. Ask for their API key.
3. Set the appropriate config:

For **OpenAI**:
```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
DEFAULT_AGENT=openai
```

For **Anthropic**:
```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-20250514
DEFAULT_AGENT=anthropic
```

They can configure both providers and switch between them later.

## Step 5 — First Run

1. Install dependencies: `npm install`
2. Initialize an empty task queue: create `tasks/queue.yaml` with content `tasks: []`
3. Run the first cycle:
```bash
npx tsx src/cli.ts autopilot --projects {project-id} --cycles 1 --feature-ratio 0.8
```

For multi-project:
```bash
npx tsx src/cli.ts autopilot --projects {api-id},{ui-id} --cycles 1 --feature-ratio 0.8
```

Explain what will happen:
- OpenTangl reads the vision doc and scans the codebase
- It proposes tasks aligned with the vision
- It executes each task autonomously (writes code, runs verification)
- It creates PRs, reviews them with the LLM, and merges if clean
- At the end, it updates the vision doc with progress

4. After the first run, review the results together. Check the sanity check output and the updated vision doc.

## Ongoing Usage

After setup, the user runs autopilot whenever they want development cycles:

```bash
npx tsx src/cli.ts autopilot --projects {ids} --cycles {n} --feature-ratio 0.8
```

Key flags:
- `--cycles N`: how many propose-execute loops to run
- `--feature-ratio 0.8`: 80% features, 20% maintenance/testing (adjustable)
- `--agent openai|anthropic`: override the default LLM provider

For background execution (keeps running after terminal closes):
```bash
nohup caffeinate -dims npx --yes tsx src/cli.ts autopilot --projects {ids} --cycles 3 --feature-ratio 0.8 > /tmp/opentangl.log 2>&1 &
```

## Troubleshooting

- **"No pending tasks"**: The queue is empty. Run autopilot to have the LLM propose tasks, or the vision doc may need more specific priorities.
- **Build failures**: OpenTangl retries up to 3 times with error feedback. If all attempts fail, the task is marked failed and skipped.
- **Escalated PRs**: The LLM reviewer flagged critical concerns. Check the GitHub issue it created for details.
- **"OPENAI_API_KEY is required"**: Copy `.env.example` to `.env` and add your key.
