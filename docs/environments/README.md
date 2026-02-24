# Environments

Each subdirectory represents a **product environment** — a set of repos OpenTangl manages as a cohesive product. Environment docs serve as the onboarding source of truth: what the product is, how the repos fit together, and the product vision that drives autonomous prioritization.

## Structure

```
environments/
├── my-product/
│   ├── onboarding.md     # Integration notes, repo inventory, config decisions
│   └── product-vision.md # North star + living priorities (updated by autopilot)
└── README.md             # This file
```

## Adding a New Environment

1. Create a directory under `environments/` named after your product.
2. Add `product-vision.md` — use the template at `examples/product-vision.md.template`. Write the Origin & Direction section (human-authored, never modified by OpenTangl). Add initial priorities for the autopilot.
3. Register the projects in `projects.yaml` at the root — use `examples/projects.yaml.example` as reference.
4. Optionally add backlog tasks in `tasks/backlog/{project-id}.yaml`.

Or just ask your AI coding tool "how do I get started?" and it will walk you through all of this.
