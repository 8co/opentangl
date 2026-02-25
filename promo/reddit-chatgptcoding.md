# Title

I built an open-source autopilot that writes code, creates PRs, and merges them — autonomously across multiple repos

# Body

I've been building a tool called **OpenTangl** that runs as an autonomous development loop. You write a product vision doc describing what you want built, point it at your repos, and it:

1. Scans your codebase to understand the architecture
2. Proposes tasks aligned with your vision (features, maintenance, tests)
3. Writes the code using GPT-4o or Claude
4. Runs your build/test commands to verify nothing breaks
5. Creates a PR on GitHub
6. Reviews its own diff with the LLM
7. Merges if clean, escalates if not
8. Updates the vision doc with progress

Then it loops and does it again.

**The key thing that makes it different from other AI coding tools:** it manages multiple repos as a single product. If your frontend needs an API endpoint that doesn't exist yet, it knows to build the API task first, merge it, then build the frontend feature that depends on it. Cross-repo task ordering with `depends_on`.

I've been running it against my own projects for a few months. It's not perfect — sometimes the LLM generates bad code, sometimes builds fail — but it retries with error context and self-corrects about 80% of the time. The other 20% it escalates to a GitHub Issue for you to look at.

**What it costs:** A typical cycle of 4-5 tasks runs about $0.30-0.50 in API costs.

It works with Cursor (has a `.cursor/rules/` onboarding guide), Claude Code (`CLAUDE.md`), and GitHub Copilot (`.github/copilot-instructions.md`). Just open the project in your editor and ask "how do I get started?" and the AI walks you through setup.

**Tech stack:** TypeScript, Node.js, OpenAI or Anthropic APIs, GitHub CLI for PR operations. No cloud services required — runs entirely on your machine.

GitHub: https://github.com/8co/opentangl

Happy to answer questions about how it works under the hood.
