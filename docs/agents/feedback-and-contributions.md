# Feedback and contributions

For coding agents working in an application that uses Filevora. This is not for agents editing this repository; those follow [AGENTS.md](../../AGENTS.md).

Filevora is an open-source library. When it gets in the way, a bug report or a pull request helps every project that uses it. Follow the steps below.

## 1. Decide what kind of problem it is

| Situation                                                              | Where to go                                                              |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Your code calls the API wrongly, or a config value is invalid          | Fix your app. Use [troubleshooting](troubleshooting.md) and the checks below. |
| The documented behavior is wrong, missing, or contradicts the manifest | Open an issue (step 3). Propose a fix with a pull request (step 4).      |
| You think you found a security vulnerability                           | Do not open a public issue. Use a private advisory (step 2).             |

Run these first. They print the exact route, environment variable, or error code the library expects:

```bash
npx filevora config validate --json
npx filevora doctor --json
npx filevora manifest --json
```

`docs/agents/capabilities.json` lists every export, route, environment variable, and error code. Entries marked `tested` are covered by the automated test suite. Treat untested entries as unverified.

## 2. Security issues

Report vulnerabilities through a private GitHub security advisory: https://github.com/AlessandroCipolletti/Filevora/security/advisories/new

Do not open a public issue, a public pull request, or a message in a public channel for an unfixed vulnerability. Ask the user to confirm before you send anything about a security problem outside the advisory.

## 3. Ask for a fix or a change: open an issue

Issues: https://github.com/AlessandroCipolletti/Filevora/issues

Before you open one, search the existing issues. If a matching issue exists, add your case as a comment instead.

Include:

- Filevora version (`npx filevora --version`), Node version, and operating system.
- The smallest code that reproduces the problem.
- The error `code` and `context` you received, and what you expected instead.
- The documentation section or manifest entry that describes the expected behavior.
- Output of `npx filevora doctor --json`, with secrets removed first.

Never paste signing secrets, S3 keys, database URLs, API keys, or `.env` contents. Replace each value with a placeholder before you paste.

Do not edit files inside `node_modules/filevora` to work around a bug. The change is lost on the next install and hides the problem from the maintainers. Use a documented option, a wrapper in your own code, or a version pin, and report the bug.

## 4. Propose a fix: open a pull request

For a bug with a clear fix, or a documentation correction, open a pull request directly. For anything larger than a bug fix, open an issue first so the approach can be agreed before you write code.

Steps:

1. Fork https://github.com/AlessandroCipolletti/Filevora and create a branch from `master`. Keep the change to one bug or one feature.
2. Install dependencies with `pnpm install`. The repository needs Node 22.13 or later and uses pnpm. Do not use Bun.
3. Run the static checks: `pnpm run ci`. This runs typecheck, lint, knip, circular import checks, and the capability manifest check.
4. Run the tests. Run `pnpm test:docker` when Docker with Compose v2 is available. It starts Redis, MinIO, Postgres, and MySQL in containers and removes them afterwards. If you cannot run Docker, say so in the pull request. GitHub Actions runs the full test jobs.
5. Add a regression test for a bug fix. Tests live in `packages/filevora/test/`.
6. Update the docs that describe the changed behavior: `README.md` and the docs under `docs/`.
7. If you change the capability manifest, edit `docs/agents/capabilities.hand.json` and run `pnpm manifest`. Do not hand-edit `docs/agents/capabilities.json`. `pnpm manifest:check` fails when the generated files are out of date.
8. Add an entry under `## Unreleased` at the top of `CHANGELOG.md`.
9. If the change reverses an architecture decision, add a new ADR in `adr/` instead of editing the old one.
10. Write the pull request description: the problem, the fix, the tests you ran, and anything you did not verify.

Do not bump the version. Do not run `pnpm release`, publish to npm, or read or write `.env.release.local`. Maintainers release.

Changes that add billing, user accounts, API-key issuance, a dashboard, UI components, or a hosted service are out of scope for this package and will not be merged.

## What maintainers need from you

- A reproduction the maintainers can run, not only a description.
- Tests that fail before the fix and pass after it.
- No secrets, no generated files that were not regenerated, and no unrelated formatting changes.
