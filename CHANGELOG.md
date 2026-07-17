# Changelog

All notable changes to ocask are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/). See [RELEASING.md](RELEASING.md) for the process.

## [Unreleased]

### Added
- **Failure-mode taxonomy in the log record** (#13): every failure record now carries
  `class` (`judgment`/`no-judgment`), `subclass` (`reply-unusable`/`reply-absent`/
  `indeterminate`), `locus` (`our-side`/`their-side`), the true unwrapped `mechanism`,
  attributed `provider`/`model`, and `duration_censored` — so a cause is recoverable from
  a single log line.
- **Four-way caller contract** (#11): ocask signals `APPROVED` / `WARNING` / `BLOCKED` /
  `no-judgment` via both an exit-code band (`0` / `0` / `20` / `30`) and a self-describing
  `--json` object `{outcome, verdict, reason, locus, mechanism, exit_code, output}`. A piped
  caller gets the full outcome without reading stderr.
- **Continuous integration** (#14): a lean GitHub Actions workflow runs `node --test` on every
  pull request and push to `main`; `main` is a protected branch requiring the check to pass.
- Project governance: `LICENSE` (Apache-2.0), `NOTICE`, `CONTRIBUTING.md`, `SECURITY.md`,
  `RELEASING.md`, and this changelog.

### Changed
- **Exit codes** now follow the four-way contract: a failed/`no-judgment` run exits `30`
  (was `1`), and a `BLOCKED` verdict exits `20`. **Exit `0` now requires a positively-produced,
  parseable verdict** — an empty or failed run can no longer be mistaken for success. Consumers
  that checked `exit == 0` for `--require-verdict` must adopt the conforming-consumer rule
  (proceed only on a parsed `APPROVED`/`WARNING`).
- `--json` output is now a structured outcome object rather than the bare JSON-encoded model
  text.
- The reported failure `mechanism` is now the true provider error (e.g. `TIMEOUT`,
  `AUTH_FAILURE`) instead of the collapsed `all_exhausted` wrapper.
- License changed to **Apache-2.0** (the README previously stated MIT; no `LICENSE` file had
  been published).

### Fixed
- **Inert installed CLI**: the symlinked entrypoint guard compared the link path against the
  resolved target, so `main()` never ran and every invocation exited `0` with empty output.
  The guard is now symlink-safe.

## [0.1.0]

Initial pre-release: provider-agnostic analytical CLI (DeepSeek V4 Pro, Qwen 3.7, OpenCode Go),
review lenses, fallback chain, metadata/logging, `doctor`/`diagnose`, and pricing.

[Unreleased]: https://github.com/anthonykewl20/ocask/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/anthonykewl20/ocask/releases/tag/v0.1.0
