# Issue #9 — Redactor Half: OWN-SECRET-SCRUB Design & Threat Analysis

## Status

Design deliverable only. No source edits. This document is the implementation spec for
the mechanism_message scrubber. The `prompt_hash` half of #9 is a separate task.

---

## 1. Grounding — What We Protect, Where It Lives, How It Flows

### 1.1 Secret Inventory (the exact values that must never persist in mechanism_message)

| # | Secret | Location | Resolution |
|---|--------|----------|------------|
| S1 | `DEEPSEEK_API_KEY` | `process.env.DEEPSEEK_API_KEY` | env var; if missing, read from file |
| S2 | DeepSeek key file | `~/.deepseek-key` | `resolveApiKey` in `providers/deepseek.mjs:15-23` reads it |
| S3 | `QWEN_API_KEY` | `process.env.QWEN_API_KEY` | env var; if missing, read from file |
| S4 | Qwen key file | `~/.qwen-key` | `resolveApiKey` in `providers/qwen.mjs:16-24` reads it |
| S5 | OpenCode server password | `OPENCODE_SERVER_PASSWORD` env var (set at `providers/opencode.mjs:156`); also persisted in `server-state.json` (runtime dir) | `randomBytes(32).toString('base64url')` at `opencode.mjs:206`; `readServerState` at `opencode.mjs:89-101` reads it back; `probeServerHealth` at `opencode.mjs:109-123` sends it in `Authorization` header |
| S6 | OpenCode Go key file | `~/.opencode-go-key` | `ocverify.mjs:623-631` reads it; ancillary but present in the process |

### 1.2 Current Failure-Message Flow (where mechanism_message is needed and where it must NOT go)

**Producer (error creation):** Each provider creates a `ProviderError(message, code)` whose
`.message` is the provider's own words. These messages can contain echoed API keys when
the provider rejects a bad auth header and echoes it back, or when connection-level errors
serialize credentials.

Key creation sites:

| Provider | File:Line | Escape hatches |
|----------|-----------|----------------|
| DeepSeek | `providers/deepseek.mjs:91-92` (non-JSON parse), `:97,100,104,106` (error responses) | `response.text().slice(0,200)` at :91; `body?.error?.message` at :97 |
| Qwen | `providers/qwen.mjs:109-110` (non-JSON), `:118,122,125,128,130` (error responses) | `response.text().slice(0,200)` at :109; `extractQwenErrorMessage(body)` at :55-59 |
| OpenCode | `providers/opencode.mjs:374-377` (TIMEOUT, OPencode_EXHAUSTED, PROCESS_EXIT) | `error.message` at :374; spawn errors at `:157,288,297` |
| Factory | `providers/factory.mjs:123-124` (ALL_PROVIDERS_EXHAUSTED wrapper) | `lastError.message` embedded in wrapper message |

**Consumer (log write):** `logging.mjs:logAttemptResult` (line 282) and `logError` (line 326)
write structured records. **Neither currently includes `error.message`** — the
`mechanism_message` field does not yet exist in the code. It must be ADDED by this design.

**Metadata path (must NOT receive mechanism_message):** `ocask.mjs:336` builds a `metadata`
object with stable keys only (no free text). On success, `ocask.mjs:628` writes it via
`writeAtomicPrivate`. On failure, `ocask.mjs:655` writes `error.ocaskMetadata` (same object
shape). The `mechanism_message` field must never be added to this `metadata` object.

### 1.3 The Three Trust Domains (from #3 contract)

```
Domain 1: Local operator log (~/.local/share/ocask/log.jsonl, mode 0600, dir 0700)
          → stable keys + bounded+scrubbed mechanism_message
Domain 2: --metadata file (user-specified path, 0600 atomic write)
          → stable keys ONLY, no free-text message
Domain 3: stderr / --json stdout (process output)
          → human cause line only, no raw provider message
```

The redactor protects the boundary between Domain 1 and Domain 2. It operates on data
flowing INTO Domain 1 (the log), guaranteeing that by the time data reaches the log write,
all own-secret values are stripped. Domain 2 is protected by NOT routing the message there
at all (architectural confinement, not scrubbing at the boundary).

---

## 2. OWN-SECRET SCRUB (Certainty-Based Value Matching)

### 2.1 Principle

Strip the EXACT secret values. Match on the value string itself, not on patterns,
prefixes, or structural heuristics. If we hold `sk-abc123` and the message contains
`...header: Bearer sk-abc123...`, we match on `sk-abc123` — the substring — and
replace it. We do NOT guess that `glpat-...` tokens are secrets (block-list pattern
redaction fails open on novel formats).

### 2.2 Secret Value Gathering at Runtime

**Function: `gatherSecretValues(env = process.env)`**

Pseudo-signature:
```js
gatherSecretValues(env = process.env): string[]
```

Algorithm:
1. Start with empty set `secrets`.
2. From `env`, collect non-empty trimmed values for: `DEEPSEEK_API_KEY`, `QWEN_API_KEY`,
   `OPENCODE_SERVER_PASSWORD` (if set).
3. From filesystem (best-effort, synchronously): read `~/.deepseek-key` and `~/.qwen-key`.
   If either file exists and is readable with non-empty content, add the trimmed content.
   File read failures (ENOENT, EACCES) are silently skipped — the env var already covers
   that secret (or the provider itself would fail to start).
4. From runtime dir (best-effort): read `server-state.json` from
   `XDG_RUNTIME_DIR/ocask/` or `/tmp/ocask-<uid>/`, extract the `password` field.
   If the file doesn't exist or isn't readable, skip — the password may never have
   been generated in this process, or the server workflow isn't active.
5. From filesystem (best-effort): read `~/.opencode-go-key`, add trimmed content.
6. De-duplicate by value. Remove empty strings. Remove values shorter than 8 chars
   (the minimum plausible key length; a 4-char value is a false-positive risk with
   no security benefit).
7. Return sorted array (longest-first, for greedy replacement safety — see Note below).

Note on ordering: Replacement must process secrets longest-first. If `sk-abc` and
`sk-abcdef` are both in the set, replacing `sk-abc` first would leave `def` orphaned
and fail to match the longer key. Longest-first guarantees that the longer key is
matched first, then the shorter.

### 2.3 Value-Matching Algorithm

**Function: `scrubSecrets(text, secrets)`**

Pseudo-signature:
```js
scrubSecrets(text: string, secrets: string[]): string
```

Algorithm:
1. If `text` is not a non-empty string, return as-is (null/undefined passthrough).
2. For each `secret` in `secrets` (longest-first order):
   - If `text.includes(secret)`:
     - Replace all occurrences (globally) with `[REDACTED:own-key-${sha256Trunc8(secret)}]`
     - The truncated hash suffix is a stable, non-invertible fingerprint that lets an
       operator correlate across log lines ("was it the deepseek key or the qwen key?")
       without revealing a single bit of the key.
3. Return scrubbed text.

Why SHA-256 truncated to 8 hex chars (32 bits):
- Not invertible (one-way hash of the full secret value).
- Collision probability across ~5 secrets is negligible for operational correlation.
- 8 chars is short enough to not bloat the bounded message field.
- Even if an attacker obtains the log, the truncated hash alone cannot recover the key
  (brute-forcing a 32+ char random key from 32 bits of hash is infeasible; rainbow
  tables are irrelevant because each key is random).

### 2.4 Encoded-Form Considerations

A provider error may contain the secret in forms other than raw plaintext:

| Form | Example | Match Strategy |
|------|---------|----------------|
| Raw plaintext | `sk-abc123` in error body | Direct `.includes()` — covered |
| Base64-encoded credentials | `Basic <b64>` with key in the b64 blob | We would need to b64-encode the key ourselves and check. **Not done in V1** — accepted residual risk. The key IS matched if the error also contains the raw form; if the error contains ONLY b64-form, it survives. This is a confined log, not a public channel. |
| URL-encoded | `sk-abc123` → `sk%2Dabc123` | **Not done in V1** — accepted residual risk. |
| Partial echo | Provider truncates to first N chars | Not matchable by exact substring. Accepted residual risk. |
| Case variant | N/A — API keys are case-sensitive by convention; the raw value is canonical |

The posture is: we strip the known canonical values. Encoded or partial echoes that
survive are acceptable because the log is 0700-confined operator-only (Domain 1).
The threat model for the log is: an operator with `sudo` or filesystem access to
`~/.local/share/ocask/` can already read `~/.deepseek-key` directly if they have
that level of access. The residual risk is that a less-privileged reader of the log
file sees an encoded/truncated key fragment. Bounding and confinement reduce this
to an acceptable level.

### 2.5 Code Seams (where the scrubber plugs in)

The scrubber runs at the LAST responsible moment before persistence — just before
the log line is written. This is the single choke point that catches all messages
regardless of which provider or error code produced them.

**Primary seam: `logging.mjs:logAttemptResult` (line 282) and `logging.mjs:logError` (line 326)**

These are the only two functions that write failure records to the log. Both need a new
`mechanismMessage` parameter (or, equivalently, we add a `mechanismMessage` field to the
`classification` object, and `_classificationFields` spreads it — but the scrubbing must
happen BEFORE the field reaches the log, not inside the classification).

**Recommended approach: a standalone scrub-at-boundary function:**

```
logging.mjs:logAttemptResult → receives error object → extracts raw message →
  scrubMessage(rawMessage) → scrubbed + bounded → passes to logEvent
```

The cleaner pattern is to add `mechanismMessage` as an explicit parameter to
`logAttemptResult` and `logError`, and let the CALLER (in `ocask.mjs`) do the
scrubbing before passing it. This keeps the scrubber at the application boundary,
not inside the logging module (which should not need to know about secrets).

**Call sites in `ocask.mjs`:**

1. `ocask.mjs:380` (attempt failure in `timeAttempt`):
   ```js
   await logAttemptResult({
     ...,
     mechanismMessage: scrubMessage(error?.message),
   });
   ```

2. `ocask.mjs:400` (primary fatal error):
   ```js
   await logError({
     ...,
     mechanismMessage: scrubMessage(primaryError?.message),
   });
   ```

3. `ocask.mjs:410` (fallback fatal error):
   ```js
   await logError({
     ...,
     mechanismMessage: scrubMessage(fbError?.message),
   });
   ```

**Alternative seam (if we want the logging module to own scrubbing):**
Add scrubbing inside `logEvent` at `logging.mjs:245`, intercepting the `mechanism_message`
field before JSON stringification. This has the advantage of being a single choke point
but the disadvantage of coupling logging to the secret-gathering machinery. The caller-side
approach is preferred for separation of concerns.

---

## 3. DEFAULT-DENY (Saltzer & Schroeder Fail-Safe Defaults)

### 3.1 Principle

If the scrubber cannot execute — environment unavailable, secret-gathering throws,
SHA-256 unavailable — the message MUST be dropped entirely to a safe placeholder.
Never write raw.

### 3.2 Failure Semantics

**Function: `scrubMessage(rawMessage, env?, deps?)`**

```js
scrubMessage(rawMessage: string | null | undefined): string
```

Behavior by scenario:

| Scenario | Outcome | Logged value |
|----------|---------|--------------|
| Normal: rawMessage is non-empty string | Scrub with gathered secrets, bound to MAX_MECHANISM_MSG_LENGTH | Scrubbed + bounded text, with truncation marker if applicable |
| Normal: rawMessage is empty/null/undefined | No scrubbing needed | `""` (empty string — not null, so consumers can distinguish "no message" from "scrubber down") |
| Scrubber throws (e.g., crypto unavailable) | DEFAULT-DENY | `"[scrubbed:unavailable]"` (constant placeholder) |
| Secret gathering throws (e.g., env parse error) | DEFAULT-DENY | `"[scrubbed:unavailable]"` |
| Scrubbed result is empty after stripping all secrets | Valid result | `""` (empty — all content was secrets, stripped) |

The placeholder `"[scrubbed:unavailable]"` is deliberately chosen:
- It IS alphabetic (satisfies `mechanism_message` schema expectations).
- It signals "the scrubber ran but couldn't operate" — distinguishable from "the
  provider produced no message" (empty string).
- It contains no raw provider data.
- It does not reveal WHY the scrubber failed (which could leak env state).

### 3.3 Implementation Detail

The scrubber is wrapped in a try/catch that returns the placeholder on any throw.
The try/catch is INSIDE `scrubMessage`, so callers never need to handle scrubber
failure — they always get a safe string back.

```
function scrubMessage(raw, env) {
    try {
        const secrets = gatherSecretValues(env);
        const text = typeof raw === 'string' ? raw : '';
        const scrubbed = scrubSecrets(text, secrets);
        return boundMessage(scrubbed);
    } catch {
        return '[scrubbed:unavailable]';
    }
}
```

---

## 4. BOUND + CONFINE

### 4.1 Bound Length

**Constant: `MAX_MECHANISM_MSG_LENGTH = 200`**

The contract (#3, research §3 GDPR 5(1)(c)) specifies ~200 chars. This is enforced
as a hard cap, with truncation marked.

**Function: `boundMessage(text, maxLen = 200)`**

```
boundMessage(text: string, maxLen?: number): string
```

Algorithm:
1. If `text.length <= maxLen`, return as-is.
2. Otherwise, return `text.slice(0, maxLen - 3) + '…'` (U+2026 single-character ellipsis).
   The indicator occupies 1 char, so the useful prefix is maxLen-3 chars.
3. The '…' marker is a visible, unambiguous signal that the message was truncated.
   It is NOT a prefix like `[TRUNCATED]` which would consume ~12 chars of the budget.

Rationale for 200 chars:
- GDPR 5(1)(c) data minimisation: store only what is diagnostically necessary.
- Provider error messages that exceed 200 chars are typically stack traces or full
  response bodies — not actionable for diagnosis.
- The stable keys (mechanism code, http_status, locus) carry the structured cause;
  the message is supplementary color, not the primary diagnostic channel.
- 200 chars covers typical error messages (e.g., `"DeepSeek API error: Authentication failed for API key"`)
  while capping verbose responses.

### 4.2 Confinement to Local Log Only

**The mechanism_message field must NEVER enter the `--metadata` path.**

Current state (pre-design): The `metadata` object at `ocask.mjs:336` does NOT contain
any free-text message field. This is correct and must be preserved.

**Guarantee by construction (not by scrubbing at the boundary):**

1. `mechanismMessage` is passed ONLY to `logAttemptResult` and `logError` (`logging.mjs`).
2. The `metadata` object at `ocask.mjs:336` is built separately — it never receives
   `mechanismMessage` because there is no code path that adds it.
3. The `mechanismMessage` parameter on `logAttemptResult`/`logError` writes directly
   to the log via `logEvent` — it never touches the `metadata` object.
4. `writeAtomicPrivate` at `ocask.mjs:628` / `:655` writes `metadata` (or
   `error.ocaskMetadata`) — neither object contains `mechanismMessage`.

**This is architectural confinement, not a runtime check.** A future developer adding
`mechanismMessage` to the metadata object would need to explicitly modify the metadata
builder at `ocask.mjs:336`. A comment at that site ("DO NOT add mechanism_message to
metadata — it is Domain 1 only") serves as a guardrail, but the primary defense is
that metadata and log writes are separate code paths.

**Verification seam:** A test can assert that `error.ocaskMetadata.mechanism_message`
is undefined after a provider failure that produces a mechanism_message in the log.
See Test Plan §6.3.

---

## 5. NOT A BLOCK-LIST PATTERN REDACTOR

### 5.1 Why Block-List Pattern Redaction Fails Open

A pattern-based redactor matches known key formats (e.g., `/sk-[a-zA-Z0-9]{32,}/` for
Stripe-style keys). This is the approach used by many logging libraries. It has a
fundamental flaw: **it fails open on novel formats**.

Consider these real scenarios:

| Secret format | Pattern `sk-…` catches? | Pattern `Bearer …` catches? | Own-value scrub catches? |
|---------------|------------------------|-----------------------------|--------------------------|
| `sk-abc123...` (DeepSeek) | Maybe (if regex matches DeepSeek format) | No | YES (exact value match) |
| `glpat-xyz...` (GitLab PAT) | NO — never seen the `glpat-` prefix | NO | NO (but this is a third-party secret — see residual risk) |
| `sk-abc` truncated to 6 chars in error | No — too short for pattern | No | No (but partial echo, accepted residual risk) |
| Qwen API key (unprefixed, random-looking) | No — no `sk-` prefix | No | YES (exact value match) |
| OpenCode server password (base64url, 43 chars) | No — no recognizable prefix | No | YES (exact value match) |

**#3 sad-path 2** specifically calls this out: a naive `sk-…` / `Bearer …` stripper
leaks a `glpat-…` token. The fix is to match on known OWN values with certainty, not
to guess at unknown patterns.

### 5.2 Why Own-Value Scrub + Local-Only Confinement + Bound Is the Correct Posture

The three-layer defense:

1. **Own-value scrub (Layer 1):** Strip the secrets we KNOW about with certainty.
   This catches the expected failure mode: a provider echoes our API key back in an
   error message.

2. **Local-only confinement (Layer 2):** The log is 0700 operator-only. Even if a
   third-party secret survives scrubbing, it is in a file that only the operator
   (who already holds the keys) can read. The attack surface is: a log file copied
   off-machine or shared accidentally.

3. **Bound length (Layer 3):** A 200-char cap prevents a full API response body
   (which could contain a prompt, a key, and surrounding context) from being stored.
   This limits the blast radius of a missed secret.

This is defense-in-depth: Layer 1 is active (scrubbing), Layer 2 is architectural
(access control), Layer 3 is quantitative (size cap).

### 5.3 Secondary Pattern Pass — Acceptable and Where

A secondary pattern pass is acceptable as a DEFENSE-IN-DEPTH layer, running AFTER
own-value scrubbing and ONLY for well-known formats that are NOT our own keys. This
is a "nice to have" for third-party secret formats that happen to match known patterns.

**Where it would go:** Inside `scrubSecrets()`, as an optional second pass after
own-value matching.

**What it would strip:** Well-known generic patterns like:
- `/Bearer\s+[A-Za-z0-9+/=]{20,}/g` (Authorization header values) — but note that
  our own values are already stripped by Layer 1, so this catches only third-party
  Bearer tokens.
- `/(sk|pk|rk)_(live|test)_[A-Za-z0-9]{24,}/g` (Stripe-style keys)

**Why it is NOT the primary defense:** Because it is inherently incomplete. A
novel third-party API will produce novel key formats that this pattern doesn't know.
Layer 1 (own-value) covers the known keys with certainty; Layer 2+3 provide
defense-in-depth for unknowns. Adding Layer 1.5 (pattern pass) is acceptable but
must be documented as "best-effort only, not relied upon for own secrets."

**Recommendation for V1:** Skip the secondary pattern pass. Ship with own-value
scrub + confinement + bound. Add pattern pass in a follow-up if operational
experience shows third-party keys in the confined log. This avoids shipping a
feature that might create false confidence.

---

## 6. Implementation Plan

### 6.1 New Module: `scrubber.mjs`

A new, single-responsibility module with no dependencies on other ocask modules
(only `node:crypto` and `node:fs/promises` and `node:path` and `node:os`).

**Exports:**

```js
export const MAX_MECHANISM_MSG_LENGTH = 200;

/**
 * Gather all own-secret values from environment and filesystem.
 * Returns de-duplicated, sorted (longest-first), non-empty strings.
 * Best-effort: file read failures are silently skipped.
 *
 * @param {object} [env] - process.env-like object
 * @returns {string[]} sorted unique non-empty secret values, longest first
 */
export async function gatherSecretValues(env = process.env): Promise<string[]>;

/**
 * Scrub known secret values from text using exact substring matching.
 * Returns text with matched substrings replaced by stable truncated hashes.
 *
 * @param {string} text - raw text to scrub
 * @param {string[]} secrets - secret values (output of gatherSecretValues)
 * @returns {string} scrubbed text
 */
export function scrubSecrets(text: string, secrets: string[]): string;

/**
 * Bound text to maxLen chars, appending '…' if truncated.
 *
 * @param {string} text
 * @param {number} [maxLen=200]
 * @returns {string} bounded text
 */
export function boundMessage(text: string, maxLen?: number): string;

/**
 * Full scrubber pipeline: gather → scrub → bound → default-deny.
 * This is the single entry point callers use. Returns a safe string
 * in all circumstances — never throws, never returns raw input.
 *
 * @param {string|null|undefined} raw - raw provider error message
 * @param {object} [env] - process.env-like object (for secret gathering)
 * @returns {Promise<string>} safe, scrubbed, bounded mechanism message
 */
export async function scrubMessage(raw: string | null | undefined, env?: object): Promise<string>;
```

**Internal function (sha256 truncated):**

```js
import { createHash } from 'node:crypto';

function _sha256Trunc8(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}
```

### 6.2 Call Sites (file:line)

| # | File | Line | Change |
|---|------|------|--------|
| 1 | `ocask.mjs` | ~13 | Add `import { scrubMessage } from './scrubber.mjs';` |
| 2 | `ocask.mjs` | ~376-385 | In `timeAttempt` catch block: call `scrubMessage(error?.message)` and pass to `logAttemptResult` as new `mechanismMessage` field |
| 3 | `ocask.mjs` | ~398-401 | In primary fatal catch: call `scrubMessage(primaryError?.message)` and pass to `logError` |
| 4 | `ocask.mjs` | ~408-411 | In fallback fatal catch: call `scrubMessage(fbError?.message)` and pass to `logError` |
| 5 | `logging.mjs` | ~282 | Add `mechanismMessage` parameter to `logAttemptResult` signature; write it as `mechanism_message` in the `record` object |
| 6 | `logging.mjs` | ~326 | Add `mechanismMessage` parameter to `logError` signature; write it as `mechanism_message` in the `record` object |

### 6.3 Function Signatures (modified)

**`logging.mjs:logAttemptResult`** (modified signature):
```js
export async function logAttemptResult({
  provider, model, attemptIndex, outcome, durationMs,
  timeoutMs = 0, reasonCode, outputBytes, tokensUsed, errorClass,
  classification = null,
  mechanismMessage = '',   // NEW: scrubbed + bounded provider message
}) { ... }
```

**`logging.mjs:logError`** (modified signature):
```js
export async function logError({
  model, provider, errorCode, errorClass, attemptCount, durationMs,
  timeoutMs = 0, classification = null,
  mechanismMessage = '',   // NEW: scrubbed + bounded provider message
}) { ... }
```

**`logging.mjs:_classificationFields`** (unchanged — mechanism_message is NOT a
classification field; it is a separate field on the log record, not part of the
#2 taxonomy).

### 6.4 Existing Code That Must NOT Change

| File | Line(s) | Description | Why untouched |
|------|---------|-------------|---------------|
| `ocask.mjs` | 336 | `metadata` object construction | Must NOT add `mechanismMessage` — this is the Domain 2 boundary |
| `ocask.mjs` | 628, 655 | `writeAtomicPrivate` calls | Write `metadata` only (no message field) |
| `providers/deepseek.mjs` | 15-23 | `resolveApiKey` | Stays as-is; secret gathering is in the scrubber module |
| `providers/qwen.mjs` | 16-24 | `resolveApiKey` | Stays as-is |
| `providers/opencode.mjs` | 89-101, 206 | Server state / password generation | Stays as-is; password gathering is in the scrubber module |
| `system.mjs` | 56-73 | `checkKeyFile` | Stays as-is; used by doctor, not by the scrubber |

---

## 7. Test Plan

### 7.1 Unit Tests for `scrubber.mjs`

**Test: key echoed in provider error → stripped**

Setup: `gatherSecretValues({ DEEPSEEK_API_KEY: 'sk-test-key-12345' })`.
Input: `"DeepSeek API error: Invalid API key sk-test-key-12345 for model deepseek-chat"`.
Expected: message contains `[REDACTED:own-key-<8hex>]` instead of `sk-test-key-12345`.
Assert: message does NOT contain `sk-test-key-12345`.
Assert: message still contains `"Invalid API key"` and `"deepseek-chat"` (cause still readable).

**Test: multiple keys scrubbed simultaneously**

Setup: both `DEEPSEEK_API_KEY` and `QWEN_API_KEY` in env.
Input: `"Failed with key sk-ds-abc123, retried with key sk-qw-xyz789"`.
Expected: both keys replaced with distinct truncated hashes.
Assert: neither key appears in output.

**Test: longest-first ordering prevents partial-match orphan**

Setup: secrets `['sk-abcdefgh', 'sk-abc']` (sorted longest-first).
Input: `"key: sk-abcdefgh"`.
Expected: `"key: [REDACTED:own-key-<8hex>]"` (full key matched).
Assert: message does NOT contain `sk-abc` or `defgh` (no orphan).

**Test: scrubber unavailable → dropped to placeholder**

Mock: `createHash` throws (simulate crypto failure).
Input: `"some error with key sk-test-key-12345"`.
Expected: result is exactly `"[scrubbed:unavailable]"`.
Assert: no raw message content survives.

**Test: secret gathering throws → dropped to placeholder**

Mock: `fs.readFile` throws EACCES on every path.
Input: `"some error"`.
Expected: result is `"[scrubbed:unavailable]"`.
Assert: no raw message content survives. (Note: env-based gathering must also be
covered in this error path — if `process.env` is somehow null/undefined, the
gatherer should throw, and `scrubMessage` catches it.)

**Test: empty/null/undefined input → empty string**

Setup: normal scrubber availability.
Input: `null`, `undefined`, `""`.
Expected: `""`.
Assert: not `"[scrubbed:unavailable]"` (distinguish "no message" from "scrubber down").

**Test: all-content-is-keys → empty string**

Setup: `QWEN_API_KEY = 'sk-qw-test-key'`.
Input: `"sk-qw-test-key"` (only the key, nothing else).
Expected: `""` or `"[REDACTED:own-key-<8hex>]"` (either is acceptable — the key is
gone; the empty-vs-hash decision is about whether the replacement text itself counts
as content). **Decision: keep the replacement hash** — an empty string implies "no
message was produced", which is misleading. The hash tells the operator "a message
existed but contained only our own keys."

**Test: bound/truncation at 200 chars**

Input: `"A".repeat(250)` (250 A's, no secrets).
Expected: length = 200, ends with `"…"` (not `"A"` at position 199).
Assert: `result.endsWith('…')`.

**Test: bound/truncation at exactly 200 chars**

Input: `"B".repeat(200)`.
Expected: length = 200, does NOT end with `"…"` (no truncation needed).

**Test: bound/truncation preserves scrubbed content**

Input: 250-char message with key at position 210.
Expected: key is NOT in the output (it's at position 210, truncated away).
Assert: the truncation boundary itself does not leak a key fragment.

**Test: truncated hash is stable across calls**

Setup: same secret value.
Call `_sha256Trunc8('sk-test-key')` twice.
Expected: same 8-char hex output both times.
Assert: `hash1 === hash2`.

**Test: truncated hash differs for different keys**

Setup: `'key-a'` vs `'key-b'`.
Expected: different 8-char hex outputs.
Assert: `hash_a !== hash_b`.

### 7.2 Integration Tests (black-box, exercise log + metadata)

**Test: mechanism_message in log after provider failure**

Setup: redirect log to temp dir (`XDG_DATA_HOME`), trigger an `AUTH_FAILURE` via
`runAsk` with a fake provider that throws a `ProviderError` containing a known
key value in the message.
Assert: `log.jsonl` contains a line with `"mechanism_message"` field.
Assert: the field does NOT contain the key value.
Assert: the field DOES contain `[REDACTED:own-key-<8hex>]`.

**Test: message never in --metadata**

Setup: trigger a provider failure that produces an error with `ocaskMetadata`.
Assert: `error.ocaskMetadata.mechanism_message === undefined`.
Assert: `error.ocaskMetadata` contains only stable keys (model, duration_ms,
attempts array, exit_code, input_bytes, output_bytes, actual_model, no_fallback,
fallback_used).

**Test: scrubber-unavailable → placeholder in log, metadata still clean**

Mock: `gatherSecretValues` throws.
Assert: `mechanism_message` field is `"[scrubbed:unavailable]"`.
Assert: `--metadata` file does NOT contain `mechanism_message`.
Assert: `--metadata` file still contains stable keys (class, locus, mechanism, etc.).

### 7.3 Sad-Path Coverage (from #3 prototype, 27/27)

| # | Sad Path | Test Coverage |
|---|----------|---------------|
| 1 | Own-key echo | Unit test §7.1 "key echoed in provider error → stripped" |
| 2 | Block-list fails open | NOT applicable (own-value scrub, not pattern); but tested implicitly: a `glpat-` token in a message should SURVIVE scrubbing (we don't own it) |
| 3 | Redactor-down default-deny | Unit test §7.1 "scrubber unavailable → dropped to placeholder" |
| 4 | Size bound | Unit test §7.1 "bound/truncation" tests |
| 5 | Trust-domain leak (message in metadata) | Integration test §7.2 "message never in --metadata" |
| 9 | Random prompt_hash | Handled by the prompt_hash half of #9 (not this design) |
| 10 | Log-write failure | Existing test: `logEvent` handles ENOSPC/EACCES gracefully (best-effort append); not in scope for scrubber |

---

## 8. Residual Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|------------|--------|------------|
| R1 | Third-party secret survives own-value scrub in the confined log | Medium — a provider could echo a user's GitLab PAT or Stripe key in an error | Low — the log is 0700, operator-only; copying the log off-machine requires explicit action; the 200-char cap limits blast radius | Accepted. Eliminating entirely would mean storing no message, which loses the diagnostic value (#3 contract). |
| R2 | Encoded form of own key survives (Base64, URL-encoded) | Low — providers typically echo the key as-is in error text, not re-encoded | Low — same confinement argument as R1 | Accepted for V1. Can add b64/url-encoded matching in a follow-up. |
| R3 | Truncation boundary splits a key, leaving a fragment | Very low — keys are typically at the start or end of error messages, and 200 chars is generous | Low — a fragment of 1-3 chars is not useful as a key | Not addressed. If this becomes an issue, the truncation could be boundary-aware (break at whitespace). |
| R4 | Secret gatherer reads a leaked key file with world-readable permissions | Low — `system.mjs:checkKeyFile` already warns on permissive modes (mode `!== 0o600`) | Medium — if the key file is 0644, the gatherer reads it, but the same key is also available to any local user directly | Not the scrubber's problem. Key file permissions are a system health concern (`ocask doctor` detects this). |
| R5 | SHA-256 is unavailable (e.g., FIPS-compliant Node.js without SHA-256) | Very low — SHA-256 is available in all standard Node.js builds | Low — falls through to DEFAULT-DENY placeholder; diagnostic message is lost but no secret leaks | Accepted. The DEFAULT-DENY path is the correct behavior here. |
| R6 | `gatherSecretValues` is async and adds latency to error logging | Not a risk — error logging is already async (logEvent does fs.appendFile); a few ms of file reads is negligible | None | Non-issue. Secret gathering is in the error path, not the hot path. |
| R7 | Race condition: key file changes between gather and scrub | Extremely low — key files don't change mid-process | None — if the key changed, the old value was valid when the provider call was made, and the new value doesn't match the error message anyway | Non-issue. |

---

## 9. Summary of Design Decisions

| Decision | Rationale |
|----------|-----------|
| Exact value matching, not pattern matching | Pattern matching fails open on novel formats (#3 sad-path 2); own-value matching catches our keys with certainty |
| Longest-first replacement ordering | Prevents shorter-key-first from orphaning the suffix of a longer key |
| Truncated SHA-256 hash as replacement marker | Stable fingerprint for operational correlation; non-invertible; 8 hex chars is compact |
| 200-char hard cap with '…' marker | GDPR minimisation; diagnostic sufficiency; visible truncation signal |
| Architectural confinement to log (not metadata) | Guaranteed by separate code paths, not by runtime scrubbing at the boundary |
| DEFAULT-DENY placeholder `[scrubbed:unavailable]` | Saltzer & Schroeder fail-safe; never writes raw; distinguishable from empty message |
| Async gatherSecretValues with best-effort filesystem reads | Provider invocation is already async; filesystem reads in the error path are negligible; best-effort means we degrade gracefully if key files are unreadable |
| Secondary pattern pass deferred to follow-up | Own-value + confinement + bound is sufficient for V1; pattern pass adds complexity without adding certainty for our own keys |
| No changes to provider code or factory | Single choke point at the log-write boundary; providers remain unaware of scrubbing |

---

## 10. References

- `.evidence/issue9-body.md` — the issue requirements
- `.evidence/issue3-record-decision.md` — the failure-record contract (mechanism_message rules at §"The raw provider message — store it, but treat it as untrusted")
- `logging.mjs` — classifyFailure, logAttemptResult, logError, logEvent, unwrapOrigin
- `ocask.mjs` — metadata construction, runAsk error handling, writeAtomicPrivate
- `providers/deepseek.mjs` — DEEPSEEK_API_KEY resolution, error messages
- `providers/qwen.mjs` — QWEN_API_KEY resolution, error messages
- `providers/opencode.mjs` — OpenCode server password, error messages
- `providers/factory.mjs` — ProviderError class, ALL_PROVIDERS_EXHAUSTED wrapping
- `system.mjs` — key file health checks (not used by scrubber, but adjacent)
- `ocverify.mjs:623-631` — OpenCode Go key file (ancillary secret)
- Saltzer & Schroeder (1975) — fail-safe defaults principle
- GDPR Art. 5(1)(c) — data minimisation
- OWASP Logging Cheat Sheet — never log secrets/PII
- OTel exception conventions — `exception.message` as first-class field
- RFC 9457 §5 — Problem Details, `detail` field
