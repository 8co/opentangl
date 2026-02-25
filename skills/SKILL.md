---
name: opentangl
description: Not a code generator — an entire dev team. Point it at any JS/TS project and a product vision. It plans features, writes code, verifies builds, creates PRs, reviews diffs, and merges — autonomously. Manages multiple repos as one product. Use when you want to ship code without writing it.
homepage: https://github.com/8co/opentangl
metadata: {"clawdbot":{"emoji":"🤖","requires":{"bins":["node","git","gh"],"env":["OPENAI_API_KEY","ANTHROPIC_API_KEY"]},"primaryEnv":"OPENAI_API_KEY"}}
---

# OpenTangl

Set up a self-driving development loop for any JavaScript/TypeScript project. OpenTangl reads a product vision, proposes tasks, writes code, verifies it builds, creates PRs, reviews them with an LLM, and merges — autonomously.

## Safety

This skill performs high-impact operations: cloning a repo, running `npm install`, creating git branches, pushing to GitHub, creating PRs, and merging. Every destructive action below includes an explicit user confirmation step. **Do not skip confirmations.** If running in a fully autonomous context without user interaction, ensure you have separate policy controls gating pushes and merges. For maximum safety, run OpenTangl in an isolated environment (container or VM) and use a GitHub machine account with narrow repo-scoped permissions.

## Prerequisites

Tell the user you'll check for required tools, then run each check and report the results:

- **Node.js** ≥ 18 — run `node --version` and show the output
- **git** — run `git --version` and show the output
- **GitHub CLI** — run `gh auth status` and show the output (needed for PR creation and merging)
- An **LLM API key** — ask the user if they have an OpenAI or Anthropic API key ready

Report all results to the user. If anything is missing, tell them exactly how to install it and stop until resolved.

## Step 1 — Clone OpenTangl

```bash
git clone https://github.com/8co/opentangl.git
cd opentangl
```

**Before installing dependencies, confirm with the user:** "This will run `npm install` to download OpenTangl's dependencies (openai, anthropic SDK, yaml, dotenv, uuid). These are fetched from npm and may include lifecycle scripts. You can review `package.json` first. Proceed?"

```bash
npm install
```

If the user already has OpenTangl cloned, skip to Step 2.

## Step 2 — Determine the Target Project

Ask the user:

> Are you **(a)** building something new from scratch, **(b)** improving an existing project, or **(c)** not sure?

### Path A: New Project

1. Ask: **"What do you want to build?"** Get a 2-3 sentence description.
2. Ask: **"What type of app?"** — Frontend (React/Vite, Next.js), API/Backend (Serverless, Express), or Full-stack (both).
3. **Show the scaffold command and confirm before running:**
   - React + Vite: `npm create vite@latest {name} -- --template react-ts`
   - Next.js: `npx create-next-app@latest {name} --typescript`
   - Serverless: `npx serverless create --template aws-nodejs --path {name}`
   - Express: create `package.json` + `src/index.ts` manually
4. **Confirm with user**, then initialize git: `git init && git add . && git commit -m "Initial scaffold"`
5. **Ask the user to confirm** before creating a GitHub repo: `gh repo create {name} --public --source . --push`
6. Note the path to the new project relative to the OpenTangl root.

### Path B: Existing Project

1. Ask: **"Where is your project?"** Accept a path. If they say "this directory," use cwd.
2. Tell the user you'll read config files in their project directory to detect the setup. Only inspect files in the directory the user provided — do not scan outside it. Check:
   - **Type**: `tsconfig.json` → TypeScript, `vite.config.ts` → Vite, `next.config.*` → Next.js, `serverless.yml` → Serverless
   - **Package manager**: `package-lock.json` → npm, `yarn.lock` → yarn, `pnpm-lock.yaml` → pnpm
   - **Build/test commands**: Read `package.json` scripts for `build`, `test`, `lint`, `typecheck`
   - **Source dirs**: Default to `src/` if it exists
   - **Target branch**: Check `git symbolic-ref refs/remotes/origin/HEAD` or look for `main` vs `master`
3. Show everything you detected and confirm with the user before proceeding.
4. Ask: "Are there other repos that are part of this same product?" If yes, repeat detection for each.

### Path C: Not Sure

Ask the user to provide the path to their project directory. Once provided, check git status and read config files in that directory, then route to Path A or B.

## Step 3 — Generate projects.yaml

Create `projects.yaml` in the OpenTangl root directory. Each project entry needs:

```yaml
projects:
  - id: my-app                          # Short kebab-case ID (used in CLI flags)
    name: my-app                        # Human-readable name
    path: ../my-app                     # Relative path from OpenTangl root to the project
    type: react-vite                    # Project type (see below)
    description: React dashboard app    # One-line description
    scan_dirs:
      - src                             # Directories containing source code
    skip_patterns:
      - node_modules
      - dist
      - "*.test.*"
    verify:                             # Commands that must pass before committing
      - command: npm
        args: [run, build]
    package_manager: npm                # npm | yarn | pnpm
    merge:
      target_branch: main               # Branch PRs merge into
```

**Supported types:** `typescript-node`, `serverless-js`, `serverless-ts`, `react-vite`, `react-next`, `express` (or any descriptive string).

For **multi-project setups**, add an `environment` field to group related projects under a shared vision:

```yaml
  - id: my-api
    environment: my-product
    # ...
  - id: my-frontend
    environment: my-product
    # ...
```

## Step 4 — Create the Vision Doc

Create `docs/environments/{environment}/product-vision.md` (use the project `id` as environment name for single projects, or the `environment` field for multi-project).

The vision doc has two sections:

### Origin & Direction (human-authored, never modified by OpenTangl)

Ask the user to describe:
- **What This Is** — 2-3 sentences about the project
- **Where It's Going** — long-term direction, 6-12 months out
- **What Matters Most** — 3-5 principles guiding decisions

### Current Priorities (maintained by OpenTangl after each run)

Ask: **"What are the first 3-5 things you want built or improved?"**

Write them as Active Initiatives:

```markdown
### Active Initiatives

1. **{Priority}** — {What and why}
   - Status: not started
```

If the user isn't sure, offer to scan the codebase and suggest priorities.

## Step 5 — Configure the LLM

Before creating the `.env` file, **verify that `.env` appears in the project's `.gitignore`** by reading the file. Confirm to the user that it is gitignored so keys will never be committed or pushed.

If `.env` is NOT in `.gitignore`, add it before proceeding and tell the user you've done so.

**Ask the user which provider they want to use**, then have them paste their key. Do not store or log the key anywhere other than the `.env` file.

**For OpenAI:**
```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
DEFAULT_AGENT=openai
```

**For Anthropic (Claude):**
```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-20250514
DEFAULT_AGENT=anthropic
```

Both providers can be configured. The user switches with `--agent openai|anthropic` at runtime.

## Step 6 — First Run

Initialize an empty task queue:

```bash
mkdir -p tasks
echo "tasks: []" > tasks/queue.yaml
```

**Show the user the command and confirm before running.** The autopilot will create branches, commits, and PRs on their behalf:

```bash
npx tsx src/cli.ts autopilot --projects {project-id} --cycles 1 --feature-ratio 0.8
```

For multi-project:

```bash
npx tsx src/cli.ts autopilot --projects {api-id},{ui-id} --cycles 1 --feature-ratio 0.8
```

**What happens during a cycle:**
1. OpenTangl reads the vision doc and scans the codebase
2. It proposes tasks aligned with the vision
3. It executes each task autonomously — writes code, runs verification
4. It creates PRs, reviews them with the LLM, merges if clean
5. It updates the vision doc with progress

After the first run, review the results with the user. Check the sanity check output and the updated vision doc.

## Ongoing Usage

Run autopilot whenever development cycles are needed:

```bash
npx tsx src/cli.ts autopilot --projects {ids} --cycles {n} --feature-ratio 0.8
```

**Key flags:**
- `--cycles N` — how many propose-execute loops to run
- `--feature-ratio 0.8` — 80% features, 20% maintenance/testing (adjustable)
- `--agent openai|anthropic` — override the default LLM provider

**Background execution** (keeps running after terminal closes):

```bash
nohup caffeinate -dims npx --yes tsx src/cli.ts autopilot --projects {ids} --cycles 3 --feature-ratio 0.8 > /tmp/opentangl.log 2>&1 &
```

Monitor with: `tail -f /tmp/opentangl.log`

## Troubleshooting

- **"No pending tasks"** — The queue is empty. Run autopilot to have the LLM propose tasks, or add more specific priorities to the vision doc.
- **Build failures** — OpenTangl retries up to 3 times with error feedback. If all attempts fail, the task is marked failed and skipped.
- **Escalated PRs** — The LLM reviewer flagged critical concerns. Check the GitHub issue it created for details.
- **"OPENAI_API_KEY is required"** — Create `.env` and add your key (see Step 5).
- **Merge conflicts** — OpenTangl has a built-in conflict resolver. If it can't resolve automatically, the PR is escalated for human review.
