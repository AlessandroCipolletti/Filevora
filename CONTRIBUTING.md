# Contributing

Issues and pull requests are welcome on GitHub. The local check is:

```bash
pnpm install
pnpm verify
```

Use Node (not Bun). Keep changes scoped to one milestone or one bug. Update `CHANGELOG.md`, `README.md`, `AGENTS.md`, and `docs/agents/capabilities.json` when behavior changes. Add an ADR before changing a decision in `adr/`.

Do not publish to npm from a pull request. Do not add billing, accounts, or a hosted service.

The license is MIT. See `LICENSE`.
