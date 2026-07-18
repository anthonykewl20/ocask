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
- **Identity trust table** (#12): `--no-fallback` now pins model *identity* (not transport)
  via a curated, human-asserted trust table; transport fallback proceeds only across
  declared same-weights transports (`deepseek-v4-pro:{deepseek,opencode}`,
  `qwen3.7-plus:{qwen,opencode}`), and a DeepSeek model never routes to the Qwen provider
  (hard reject). Runs record `identity_preserved`.
- **`prompt_hash`** (#9): every run logs a SHA-256 digest of the prompt so identical tasks
  correlate across the log without ever storing prompt text.
- **Own-secret redactor** (#9): `mechanism_message` is scrubbed of known secrets before it
  touches the local 0700 log — value-based, default-deny, and never written to `--metadata`.
- **Consensus verify-panel** (#23): `--panel` runs a cross-family panel (DeepSeek + Qwen)
  under one absolute deadline; majority K-of-N with a conservative BLOCKED tiebreaker. A
  member that returns no-judgment is an ABSTENTION (not a vote) — too many abstentions fail
  closed to no-judgment (exit 30), never a false agreement.
- **Risk-based selection** (#28): `--risk auto|trivial|default|high` (default `auto`) —
  `trivial` runs a solo check, `default`/`high` run a panel; `auto` detects risk from a
  unified-diff `--context`, else `default`.
- **Multi-lens high-risk panels** (#29): `--risk high` reviews under a combined `security` +
  `code-review` + `architecture` lens set.
- **Redactor V2** (#22): the own-secret scrub now also scrubs `base64`, `base64url`, and
  URL-encoded forms of every known secret.

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
- **`ocask doctor` rewritten to the entailment rule** (#10): a cause is named only when the
  failure record *entails* it (routing on the true `mechanism` + `locus`); otherwise it
  reports `undetermined` plus the observed symptom. This retires the "no credentials"
  timeout misdiagnosis and the hardcoded "OpenCode Go out of credits" hint. Per-provider
  health is now PASS/WARN/FAIL — a 401 connectivity probe is WARN, not a green ✓; a hang's
  advice never says to raise the timeout; latency advice excludes censored (timed-out) runs.
- **Timeout model** (#8): the default timeout is now 170000ms (measured P95) with a 300000ms
  hard ceiling, enforced as ONE absolute deadline shared across primary + fallback +
  cross-verify (not per-attempt).
- **Operation-aware timeout ceiling** (#25): review/analysis ops (`--require-verdict`,
  `--panel`, `--lens`) may use up to 900000ms; plain delegation stays capped at 300000ms.

### Fixed
- **Inert installed CLI**: the symlinked entrypoint guard compared the link path against the
  resolved target, so `main()` never ran and every invocation exited `0` with empty output.
  The guard is now symlink-safe.
- **HTTP 402 locus** (#21): a 402 Payment Required now maps to the `their-side` locus,
  aligning status-derived locus with the billing/entitlement taxonomy (401/403/429 remain
  `our-side`).

## [0.1.0]

Initial pre-release: provider-agnostic analytical CLI (DeepSeek V4 Pro, Qwen 3.7, OpenCode Go),
review lenses, fallback chain, metadata/logging, `doctor`/`diagnose`, and pricing.

[Unreleased]: https://github.com/anthonykewl20/ocask/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/anthonykewl20/ocask/releases/tag/v0.1.0
