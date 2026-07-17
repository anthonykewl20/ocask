# Contributing to ocask

Thanks for your interest in ocask — the OpenCode Analytical Scrutiny Kit. This
document explains how to set up, test, and land changes. It is intentionally lean.

By contributing, you agree that your contributions are licensed under the project's
[Apache License 2.0](LICENSE), and you certify the [Developer Certificate of Origin](#developer-certificate-of-origin).

## Ways to contribute

- **Report a bug or request a feature** — open a [GitHub issue](https://github.com/anthonykewl20/ocask/issues).
  For a bug, include the exact command you ran, the observed exit code, stdout **and**
  stderr, and (if safe) the relevant line from the log at `~/.local/share/ocask/log.jsonl`.
- **Report a vulnerability** — do **not** open a public issue. See [SECURITY.md](SECURITY.md).
- **Send a pull request** — see the workflow below.

## Development setup

**Prerequisites:** Node.js ≥ 20 (the built-in test runner and ESM are used). For the
OpenCode provider, `opencode` on your `PATH`. There are **no npm dependencies** and no
build step.

```bash
git clone https://github.com/anthonykewl20/ocask.git
cd ocask
./install.sh        # symlinks the CLI onto your PATH
```

## Running tests and checks

```bash
node --test ocask.test.mjs   # the unit suite — the CI gate
./check.sh                    # static code/doc integrity checks
```

`node --test` exits non-zero on any failure; this is exactly what CI runs. A single
`check.sh` failure — `ocask does not resolve to repo` — is expected unless you have run
`./install.sh`, and is not a blocker.

### The verification bar

ocask is an analytical **gate**: a silent success is worse than a loud failure. Beyond the
unit suite, verify a change by exercising the **installed** command the way a user would —
not just `node ocask.mjs`, and never the unit suite alone. Check the return code, stdout
**and** stderr bytes: a silent `rc=0` with zero output is a failure, not a pass. If you fix a
bug, first prove your regression test fails against the old code.

## Pull-request workflow

`main` is a **protected branch**: it requires a pull request and a green CI check to merge.
Do not push directly to `main`.

1. Create a topic branch off `main` (e.g. `fix/timeout-hang`, `feat/doctor-entailment`).
2. Make focused, minimal changes. Keep unrelated refactors out of the PR.
3. Run `node --test ocask.test.mjs` and `./check.sh` locally.
4. Push the branch and open a PR against `main`.
5. CI runs `node --test` on your PR; it must pass.
6. A maintainer reviews. Once approved and green, the PR is **squash-merged**.

## Coding standards

- **Node ESM (`.mjs`), zero runtime dependencies.** Do not add npm packages.
- **Match the existing style** — comment density, naming, and idiom of the file you edit.
- **Keep changes surgical.** Prefer the smallest change that solves the problem.
- **New source files** should carry an SPDX header:
  `// SPDX-License-Identifier: Apache-2.0`
- **Tests are required** for behavior changes. Use the built-in `node:test` + `node:assert`.
- **Design decisions** for this project are recorded under `docs/research/` (the "wayfinder"
  decision docs — the failure taxonomy, timeout contract, record contract, doctor rule,
  caller contract, and `--no-fallback` scope). Read the relevant one before changing that
  area, and update it if your change alters a decision.

## Commit messages

Use a short, imperative summary prefixed by a type: `feat:`, `fix:`, `docs:`, `ci:`,
`refactor:`, `test:`, `chore:`. Reference the issue (`(#12)`). Explain the *why* in the body
for non-trivial changes. Sign off your commits (see below).

## Developer Certificate of Origin

Contributions are accepted under the [DCO](https://developercertificate.org/). Certify that
you wrote the change (or have the right to submit it) by signing off each commit:

```bash
git commit -s -m "fix: ..."
```

This appends a `Signed-off-by: Your Name <you@example.com>` line, which asserts the DCO.

## License

By contributing, you agree your contributions are licensed under the
[Apache License, Version 2.0](LICENSE), the same license that covers the project.
