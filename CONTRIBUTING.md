# Contributing

Issues and pull requests are welcome on GitHub. The local check is:

```bash
pnpm install
pnpm run verify
```

Use Node (not Bun). Keep changes scoped to one milestone or one bug. Update `CHANGELOG.md`, `README.md`, `AGENTS.md`, and `docs/agents/capabilities.json` when behavior changes. Add an ADR before changing a decision in `adr/`.

Add new `CHANGELOG.md` entries under `## Unreleased` at the top. Do not publish to npm from a pull request. Maintainers release with `pnpm release`; see [docs/releasing.md](docs/releasing.md). Do not add billing, accounts, or a hosted service.

The license is MIT. See `LICENSE`.
