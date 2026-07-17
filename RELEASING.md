# Releasing ocask

This is the maintainer process for cutting a release. It is deliberately lightweight.

## Versioning policy

ocask follows [Semantic Versioning 2.0.0](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **MAJOR** — incompatible changes to a public contract: the CLI flags, exit-code bands,
  the `--json` outcome object, or the log-record schema.
- **MINOR** — backward-compatible functionality (a new flag, a new lens, a new provider).
- **PATCH** — backward-compatible bug fixes.

**Pre-1.0 (`0.x`) caveat:** while the version is below `1.0.0`, the public contracts are
still stabilizing. A `0.x` **minor** bump may include a breaking change; it will always be
called out in the changelog under a **Changed** or **Removed** heading. Reaching `1.0.0`
signals the CLI/exit-code/`--json`/log contracts are stable.

The single source of truth for the version is `CURRENT_VERSION` in `version.mjs`. Current: `0.1.0`.

## Changelog

Every user-facing change is recorded in [CHANGELOG.md](CHANGELOG.md), which follows the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. Add entries under
`## [Unreleased]` as you merge PRs, grouped by **Added / Changed / Deprecated / Removed /
Fixed / Security**. The release step promotes `[Unreleased]` to the new version.

## Release checklist

1. **Green `main`.** Ensure `main` is green in CI and `node --test ocask.test.mjs` +
   `./check.sh` pass locally on a clean checkout.
2. **Pick the version** per the SemVer rules above (`X.Y.Z`).
3. **Update the changelog.** In `CHANGELOG.md`, rename `## [Unreleased]` to
   `## [X.Y.Z] — YYYY-MM-DD`, and add a fresh empty `## [Unreleased]` above it. Update the
   comparison links at the bottom.
4. **Bump the version.** Set `CURRENT_VERSION = 'X.Y.Z'` in `version.mjs`.
5. **PR it.** Open a `release: vX.Y.Z` pull request with the changelog + version bump. Merge
   only when CI is green (this is the same protected-branch flow as any change).
6. **Tag the merged commit** on `main`:
   ```bash
   git checkout main && git pull
   git tag -a vX.Y.Z -m "ocask vX.Y.Z"
   git push origin vX.Y.Z
   ```
   Tags are `vX.Y.Z` (with the leading `v`). Prefer annotated (`-a`), and sign (`-s`) if you
   have a signing key configured.
7. **Publish the GitHub Release.** Create a release from the tag; paste the changelog section
   for that version as the notes:
   ```bash
   gh release create vX.Y.Z --title "ocask vX.Y.Z" --notes-file <(section of CHANGELOG.md)
   ```

## Notes

- ocask is not published to npm (it has no `package.json` and no dependencies); it is
  installed from source via `./install.sh`. A release is therefore a **tag + GitHub Release**,
  not a package publish. If npm distribution is added later, document the `npm publish` step here.
- Only maintainers with push access to `anthonykewl20/ocask` can tag and publish releases.
