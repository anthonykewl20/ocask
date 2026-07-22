# Issue #81 — Keep Native Key Discovery Inside the Caller Environment

**Status:** architecture decision implemented
**Date:** 2026-07-22

---

## Context

Native DeepSeek and Qwen invocations accept a caller-owned `env`. API-key variables and most
provider configuration already come exclusively from that object, but key-file lookup used
`env.HOME || os.homedir()`. A caller that deliberately omitted `HOME` and API-key variables
could therefore expose a key from the ocask process's home directory without expressing that
access in the supplied environment.

The fallback credential predictor intentionally mirrored the same lookup so it would not skip
a transport that the provider could authenticate. Changing only the predictor or only the
providers would break that agreement.

In-tree production callers do not depend on the process-home fallback. `runMain`, `runAsk`,
and `runPanel` default to `process.env` and forward the environment unchanged; none constructs
a partial environment without `HOME`. In-tree partial environments are test fixtures, so making
the caller-owned boundary authoritative does not silently remove a working provider from an
in-tree production path.

## Decision

The native providers resolve credentials in this order:

1. Use the provider API-key variable from the caller-supplied `env` when non-empty.
2. When that same object contains a non-empty `HOME`, inspect the provider key file beneath it.
3. When `HOME` is absent or empty, do not perform key-file lookup and report `AUTH_FAILURE` if
   the provider is invoked.

The fallback credential predictor follows the identical rule. Missing `HOME` is confirmed
absence of a caller-visible key-file location, so an unpinned native transport may be recorded
as `NOT_CONFIGURED` when another compatible transport remains.

## Rejected Alternative

**Keep `os.homedir()` and document that `env` does not control home-directory access.** Rejected
because it leaves credential visibility dependent on hidden process state. Callers cannot
express a restricted environment by omission, and the security boundary implied by the `env`
parameter would remain incomplete. A caller that wants normal key-file discovery can pass
`process.env` or include `HOME` explicitly.

## Consequences

- Omitting `HOME` now prevents both native providers and the predictor from seeing process-home
  key files.
- Explicit `DEEPSEEK_API_KEY` and `QWEN_API_KEY` values continue to work without `HOME`.
- Normal CLI paths with `HOME` retain their current behavior because they pass `process.env`.
- A direct caller that supplies an environment without `HOME`, or a CLI process genuinely
  launched without `HOME`, can no longer authenticate from a process-home key file.
- The duplicated credential metadata remains deliberate for now; extracting a shared resolver
  is separate design work and is not part of this decision.
