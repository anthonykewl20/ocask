# Security Policy

ocask is an analytical gate that handles provider API keys and executes provider
subprocesses, so security reports are taken seriously. Thank you for helping keep it safe.

## Supported versions

ocask is pre-1.0 and ships from source. Security fixes are made against the latest `main`
and the most recent release.

| Version | Supported |
| --- | --- |
| `main` (latest) | ✅ |
| latest `0.x` release | ✅ |
| older | ❌ |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests,
or discussions.**

Instead, use one of these private channels:

1. **GitHub private vulnerability reporting** (preferred): open the repository's
   **Security → Report a vulnerability** advisory form
   (https://github.com/anthonykewl20/ocask/security/advisories/new).
2. **Email:** anthonykewl20@gmail.com with the subject `ocask security`.

Please include: a description of the issue, the version/commit, reproduction steps or a
proof-of-concept, and the impact you foresee. If you have a suggested fix, include it.

**Do not include real secrets** (API keys, `.env` contents) in your report; redact them.

## What to expect

This is a small project maintained on a best-effort basis. You can expect an acknowledgement
of your report, coordination on a fix and disclosure timeline, and credit in the release notes
if you would like it. Please give a reasonable window to remediate before any public disclosure.

## Security model (what to keep in mind when reviewing)

- **Secrets never go to a model.** Provider keys are read locally; they are not placed in
  prompts, argv, receipts, or cross-model context. A provider error message stored in the log
  is scrubbed of known key values, length-bounded, and confined to the local operator log —
  never to the shareable `--metadata` artifact. (See the failure-record decision in
  `docs/research/`.)
- **The log is local and access-restricted.** It is written under
  `~/.local/share/ocask/` with directory mode `0700`.
- **ocask executes provider subprocesses** (e.g. the OpenCode CLI) and reads task/context input
  from files or stdin. Reports about command injection, path traversal, secret leakage into
  logs or `--metadata`, or unsafe subprocess handling are in scope and especially welcome.
- **Residual, documented risk:** an *unknown third-party* secret that a provider echoes back in
  an error could be stored in the restricted local log. This is a deliberate, bounded trade-off
  documented in the failure-record decision; reports of leaks **beyond** that boundary (e.g.
  into `--metadata`, or of our own configured keys) are vulnerabilities.
