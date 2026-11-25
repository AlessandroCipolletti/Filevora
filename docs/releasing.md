# Releasing to npm

One command publishes a new version of `filevora` (the only published package, `packages/filevora`). Run it from the repo root, by a maintainer, on `master`. Never from a pull request.

```bash
pnpm release:dry patch          # every step except bump, commit, tag, push, publish
pnpm release patch              # 0.1.0 -> 0.1.1
pnpm release minor              # 0.1.1 -> 0.2.0
pnpm release major              # 0.2.0 -> 1.0.0
pnpm release prerelease         # 0.2.0 -> 0.2.1-beta.0, then beta.1, ... published with --tag next
pnpm release 0.1.0              # explicit version: the first publish of the version already in package.json
```

An explicit version must parse as `X.Y.Z` or `X.Y.Z-beta.N` and must not be lower than the current one. The first release uses it, because `0.1.0` is already in `packages/filevora/package.json` and `CHANGELOG.md` has its entry as the undated top heading.

## What it does

1. Checks the git tree is clean, the branch is `master`, and `HEAD` equals `origin/master` (it fetches first). Push and wait for CI before releasing.
2. Loads the npm token and creates a temporary npmrc (see below).
3. Works out the new version, rewrites `CHANGELOG.md` in memory (and fails here if that is not safe), checks the git tag `vX.Y.Z` is free locally and on origin, and checks `filevora@X.Y.Z` is not on the registry.
4. Runs `pnpm run ci` (typecheck, lint, knip, circular imports, manifest check) and `pnpm test`. No Redis server is needed: the tests start an in-memory Redis and skip the tests that need S3, Postgres, or MySQL.
5. Builds with `pnpm build`, which copies `README.md` and `LICENSE` into `packages/filevora`.
6. Runs `npm pack --json --dry-run` and checks the file list. `LICENSE`, `README.md`, `package.json`, `capabilities.json`, `bin/`, and `dist/` must be there, and nothing else: no tests, no sources.
7. Bumps `version` in `packages/filevora/package.json`, updates `CHANGELOG.md`, commits `release: vX.Y.Z` (hooks are skipped because step 4 just ran them), and tags `vX.Y.Z`.
8. Runs `npm publish --access public` in `packages/filevora`. A prerelease adds `--tag next`, so `npm install filevora` keeps resolving to the latest stable version.
9. Pushes the commit and the tag.

If anything fails before the push, including the publish, the script deletes the local tag and resets `master` to where it started, and says so. If the publish succeeded but the push failed, it tells you to push by hand and not to rerun.

`pnpm release:dry` runs steps 1 to 6, then `npm publish --dry-run`. It does not write any file, commit, tag, push, or publish, and it does not need a token. It prints the version it would use. It publishes nothing even with a token present.

## CHANGELOG

Write new entries under `## Unreleased` at the top of `CHANGELOG.md`. A stable release renames that heading to `## X.Y.Z - YYYY-MM-DD` and leaves an empty `## Unreleased` above it. An empty `Unreleased` section fails the release. A prerelease does not touch `CHANGELOG.md`; its entries move at the next stable release. If there is no `Unreleased` section and the top entry is not an undated heading for the version being released, the release stops with a message instead of guessing.

## The npm token

Create a **granular access token** at [npmjs.com](https://www.npmjs.com/) (Access Tokens) with **read and write** permission on the `filevora` package. For the very first publish the package does not exist yet, so give the token read and write on all packages (or on the scope), and narrow it afterwards. Set a short expiry.

Give the token to the script one of two ways:

- Export `NPM_TOKEN` in the shell.
- Copy `.env.release.local.example` to `.env.release.local` at the repo root and fill in `NPM_TOKEN=`. The file is gitignored. Keep it `chmod 600`; the script warns if other users can read it.

The environment wins over the file. The script never prints the token, never writes it into the repo or `~/.npmrc`, and scrubs it from all output. It passes it to npm through a temporary npmrc (directory mode 700, file mode 600, in the system temp dir, passed with `--userconfig`) that is deleted when the script ends, also on failure or Ctrl-C. Your own `~/.npmrc` is not read.

## Two-factor authentication

If the account requires 2FA for publishing, a granular token created with "bypass 2FA" needs nothing more. Otherwise npm answers with a one-time-password error. Rerun with a fresh code:

```bash
NPM_OTP=123456 pnpm release patch
```

The script passes it as `npm publish --otp`. Codes expire in about 30 seconds, so start the release shortly after reading the code; the checks take minutes, and a code that is too old makes the publish fail and the script roll back.

## Not covered

The script does not create a GitHub release and does not publish from CI. Trusted publishing (OIDC with provenance) is a possible later step; it needs a workflow file and a one-time setup on npmjs.com.
