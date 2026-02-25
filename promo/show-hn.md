# Title

Show HN: OpenTangl – Autonomous AI dev engine for multi-repo products

# URL

https://github.com/8co/opentangl

# Body (text post, optional — keep short for HN)

OpenTangl is an open-source TypeScript tool that runs an autonomous development loop. You define a product vision and point it at one or more repos. It proposes tasks, writes code via GPT-4o or Claude, verifies builds, creates PRs, reviews diffs, and merges — in a closed loop.

The part I found most useful: it manages cross-repo dependencies. If a UI feature needs a new API endpoint, it builds and merges the API task first, then builds the frontend. Task ordering via `depends_on` fields.

It runs locally on your machine. No cloud services, no accounts beyond an LLM API key and GitHub CLI. A cycle of 4-5 tasks costs about $0.30-0.50 in API calls.

Built this for my own projects over the past few months. Open-sourced it today. TypeScript, ~17k lines, MIT licensed.
