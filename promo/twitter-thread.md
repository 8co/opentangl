# Twitter/X Thread

## Tweet 1 (Hook)

I've been running an AI agent that autonomously builds my side projects.

It reads a product vision, proposes tasks, writes code, verifies builds, creates PRs, reviews them, and merges.

Today I open-sourced it. It's called OpenTangl.

github.com/8co/opentangl

## Tweet 2 (How it works)

Here's what a single cycle looks like:

1. Scans your codebase
2. Proposes tasks from your vision doc
3. Writes code (GPT-4o or Claude)
4. Runs your build commands
5. Creates a PR
6. LLM reviews its own diff
7. Merges if clean

Then loops.

[ATTACH: screenshot-setup.png]

## Tweet 3 (The differentiator)

The thing that makes it actually useful: multi-repo support.

It manages your API and frontend as a single product. If the UI needs an endpoint that doesn't exist, it builds the API first, merges it, then builds the frontend.

Cross-project dependency ordering, automatically.

## Tweet 4 (What it costs)

A full cycle — 4 tasks across 2 repos — costs about $0.35 in API calls.

It runs locally on your machine. No cloud services, no accounts beyond an LLM key and GitHub CLI.

[ATTACH: screenshot-pr-merge.png]

## Tweet 5 (Onboarding)

Setup takes ~5 minutes:

1. Clone the repo
2. Point it at your project
3. Write a product vision (what you want built)
4. Run one cycle

It even has built-in onboarding — open the project in Cursor, Copilot, or Claude Code and ask "how do I get started?"

## Tweet 6 (CTA)

It's MIT licensed, TypeScript, ~17k lines.

If you try it, I'd genuinely love feedback — especially on the task proposer quality and multi-repo coordination.

github.com/8co/opentangl

# Notes

- Attach screenshot-setup.png to Tweet 2
- Attach screenshot-pr-merge.png to Tweet 4
- Screenshots are in: /Users/8con/documents-non-icloud/opentangl/skills/assets/
