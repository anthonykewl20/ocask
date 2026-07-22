# Issue #79 — Test Telemetry Isolation Decision

## Status

Accepted and implemented.

## Context

The observability helpers resolve `XDG_DATA_HOME` at call time and all writes converge on
`logEvent`. Tests exercise both imported `runAsk`/`runPanel`/`runMain` functions and the real
`ocask.mjs` entry point in child processes. When the suite leaves `XDG_DATA_HOME` unset,
both paths append fabricated attempts to the operator's real log, and `ocask doctor` then
treats those fixtures as provider-health evidence.

Per-test opt-in isolation is insufficient: a newly added test is unsafe until its author
remembers an unrelated observability requirement. Spawned children compound the problem
because they inherit the test runner's environment.

## Decision

The suite establishes one temporary `XDG_DATA_HOME` before tests execute. Existing focused
temporary-data blocks may remain when a test needs an empty or independently inspected log.
Children inherit the safe suite default unless a fixture supplies its own isolated data home.
Alongside it, the suite sets the ocask-owned `OCASK_REFUSE_DEFAULT_LOG=1` marker once so both
in-process code and spawned children inherit the same fail-closed policy.

`logEvent`, the single persistence funnel, also refuses a write when both conditions hold:

1. `OCASK_REFUSE_DEFAULT_LOG` has the exact affirmative value `1`.
2. The active log directory resolves to the user's default data directory.

The refusal is a thrown error that tells the contributor to set `XDG_DATA_HOME` to a temp
directory. Canonical comparison resolves relative paths and existing symlinks, including a
symlinked home, and preserves missing path suffixes so a not-yet-created log directory is
still compared correctly. Other canonicalisation errors fall back to lexical normalisation,
so an unreadable or non-directory ancestor cannot crash logging to an isolated destination.
The destination is resolved before directory creation, again after creation, and immediately
before append so a symlink introduced while the path was missing is detected before writing.

These checks are not a filesystem transaction. A hostile process with permission to replace
an ancestor in the final interval between verification and append could still win that race.
The guard prevents accidental telemetry contamination by ocask's own suite; it is not an
adversarial filesystem-containment boundary.

## Alternative considered: automatic redirection

`logEvent` could silently choose a generated temp directory whenever the suite marker is set.
This avoids the write, but it also lets a logging test pass without knowing where its records
went—or while asserting nothing about persistence at all. That would make a future loss of
explicit isolation invisible. Throwing instead makes the unsafe configuration fail at its
first write and gives the exact fix, while the suite-wide temp root keeps normal tests
frictionless.

## Existing telemetry disposition

The already-corrupted history was partitioned, not deleted. Classification was by `run_id`,
and every record belonging to a run travelled together. A run was retained as real when any
of its attempts took at least 1,000 ms or billed at least 100 tokens.

Those two signals were chosen not because they are unfakeable — a stub can sleep, and a stub
can report any token count it likes — but because **the stubs actually present in this log did
not cross either threshold**: they completed in under 50 ms with no tokens, or with token
counts such as `{input:2, output:4, total:6}`. The discriminator describes the contamination
that was there, and would not survive a stub written to defeat it.

Cause was deliberately excluded, because the suite fabricates plausible causes — including
`AUTH_FAILURE` records that are indistinguishable from real ones. Two earlier attempts to
classify by cause were both defeated by fixture data.

The partition quarantined 7,627 of 10,800 records (71%) and retained 3,173. Nothing was
deleted: quarantined records were moved beside the log to
`~/.local/share/ocask/log.jsonl.quarantined-2026-07-22`, and the full pre-flight history
remains beside it at `~/.local/share/ocask/log.jsonl.backup-2026-07-22`.

The rule is a heuristic and errs in **both** directions:

- **Genuine runs quarantined.** A real near-instant local failure — a missing API key, say —
  is indistinguishable from a stub under this rule and was quarantined with the fixtures.
- **Fixtures retained.** Any stub that happened to take a second or to report a large token
  count would have been kept and counted as real. None in this log did, but the rule offers
  no guarantee of that.

Neither direction is detectable after the fact from the records alone. That uncertainty is
precisely why the records were quarantined rather than deleted: both the quarantine file and
a full pre-flight backup remain, so any misclassification is recoverable.

After partitioning, `ocask doctor` changed its opencode/deepseek-v4-pro report from 68.7%
success at 28.5 seconds average to 57.5% (624/1,085) at 40.4 seconds. The earlier figure was
largely measuring the test suite.

## Consequences

- A process that explicitly sets `OCASK_REFUSE_DEFAULT_LOG=1` is refused when its telemetry
  destination resolves to the real default log, subject to the filesystem race noted above.
- In-process calls and spawned CLI children share the same safe default construction.
- Empty or other values do not enable the guard; the only affirmative value is exactly `1`.
- Unmarked invocations are unaffected, even when `NODE_TEST_CONTEXT` was inherited
  automatically from an unrelated Node test suite and the normal default log is in use.
