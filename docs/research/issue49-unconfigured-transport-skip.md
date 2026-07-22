# Issue #49 — Skip Unconfigured Native Transports Without Losing Failures

**Status:** architecture decision implemented
**Date:** 2026-07-22

---

## Context

The default fallback chain prefers the model family's native API transport before
OpenCode. On a machine without that native API key, invoking the native transport first
produces a predictable `AUTH_FAILURE` before the configured OpenCode route gets a chance.
That failure adds noise and makes the fallback path look unhealthy even though the native
transport was never usable on that machine.

Removing a native transport from `DEFAULT_FALLBACK_CHAIN` is not a general solution. Key
availability belongs to an invocation and its caller-owned environment, not to a repository
default. A user who sets `DEEPSEEK_API_KEY` should retain the faster direct DeepSeek route.

## Decision

Before invoking a credential-bearing native transport, the provider factory checks the
caller-owned environment and the same home-directory key file used by that provider. If no
credential is present and another compatible provider remains, the factory skips invocation
and records:

```js
{ provider, duration_ms: 0, outcome: 'skipped', reason_code: 'NOT_CONFIGURED' }
```

The credential check mirrors the native provider's `env.HOME || os.homedir()` resolution and
trimmed key-file content check. Confirmed absence or empty content means unconfigured. Other
filesystem errors do not become `NOT_CONFIGURED`; the native provider is attempted so the
failure remains observable.

Two cases never take this skip:

1. An explicitly pinned provider. A pin is an operator request and must remain observable.
2. The last compatible provider. Skipping it would turn a diagnosable authentication failure
   into an evidence-free `NO_PROVIDER` result.

The check happens before provider invocation, but after lazy provider loading. A module load
failure is therefore a real `PROVIDER_UNAVAILABLE` failure, not an unconfigured-credential skip.

## Exhaustion and Error Naming

`NOT_CONFIGURED` transports are omitted from the provider names in the terminal
`ALL_PROVIDERS_EXHAUSTED` message because they never genuinely attempted transport work.
Every other recorded failure remains named, including `PROVIDER_UNAVAILABLE` load failures.
The complete `attempts` array still includes both skips and failures.

The cause-preservation invariant is unconditional:

> If `lastError` is set, the thrown `ALL_PROVIDERS_EXHAUSTED` error carries that error as
> `cause` and carries the full `attempts` array.

Both assignments to `lastError` occur only after appending a corresponding non-`NOT_CONFIGURED`
attempt: either a `PROVIDER_UNAVAILABLE` load record or a failed invocation record. Therefore
the displayed provider-name list is non-empty whenever `lastError` is set. A chain containing
only `NOT_CONFIGURED` skips cannot reach the terminal branch because the final provider is never
eligible for that skip.

## Rejected Alternative

**Delete `deepseek` from `DEFAULT_FALLBACK_CHAIN`.** Rejected because it hard-codes one
machine's credential state into global routing. It would also deny users who do configure
`DEEPSEEK_API_KEY` the fast direct route and force their requests through OpenCode.

The same reasoning applies symmetrically to Qwen credentials and the native Qwen transport.

## Consequences

- Keyless default routing reaches the next configured transport without a doomed native API call.
- Explicit pins and sole-provider chains still expose authentication failures.
- `NOT_CONFIGURED` is caller-visible in attempt history but does not falsely name an attempted transport.
- Lazy-load failures and invocation failures preserve their cause and full attempt evidence.
