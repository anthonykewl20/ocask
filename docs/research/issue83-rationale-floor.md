# Issue #83: Text rationale floor

**Decision (2026-07-22): Outcome B — document the syntactic floor honestly.**

`--require-verdict` text validation keeps its existing safety properties:

1. At least one explicit `VERDICT: APPROVED|WARNING|BLOCKED` line is required.
2. Repeated verdict lines must agree.
3. At least one Unicode letter must remain after explicit verdict lines are removed.

The third check is a nonempty-content hygiene floor. It does **not** establish
that the remaining text is reasoning. The diagnostic now describes the observable
condition directly: `Unicode letter content outside recognized explicit VERDICT lines`.

The wording is deliberate. `hasLetter` tests `\p{L}` — Unicode General_Category=Letter — which is
narrower than the Unicode *Alphabetic* property (`Ⅳ` is Alphabetic but not `\p{L}`). Calling it
"alphabetic" would have been a smaller version of the same overclaim this decision exists to remove.

## Measured evidence

Two measurements settle this, both taken from the real telemetry (`log.jsonl` plus its
`.backup-` and `.quarantined-` siblings — 21,607 events, read-only).

**1. This check has never fired.** Of 2,202 `MODEL_OUTPUT` rejections across the whole history,
the rationale floor accounts for **zero**:

| rejection reason | count |
|---|---:|
| `Could not parse response as JSON` | 1074 |
| `Review must contain exactly one explicit VERDICT line` | 782 |
| `Review must contain an explicit VERDICT line` | 216 |
| (no message) | 82 |
| `VERDICT line must appear within first five nonempty lines` | 44 |
| `Classification output did not contain a verdict` | 4 |
| **the rationale floor** | **0** |

It has never caught anything. The load-bearing properties are verdict presence and verdict
consistency.

**2. A perfect heading detector would still catch nothing.** `logVerdict` persists a 200-character
brief of every accepted review. Mining 1,868 verdict events yields 574 distinct real reviews, and
among the shortest are these — **already accepted, already shipped**:

```
Rationale: ok
Rationale: reviewed.
Rationale: smoke test ok
Rationale: valid review.
Fallback model verdict.
Rationale: independent review.
```

Every one defeats a heading rule by appending a single word, and models demonstrably already write
this way. So even a flawless heading detector delivers **no additional safety** — the reasoning-free
replies in the field are not headings.

The deeper reason is structural: the thing being gated is the same thing that reads the gate's
specification. `buildPrompt` states the requirement to the model verbatim. Any published syntactic
floor is a checklist item that can be satisfied without reasoning, by construction.

**3. The stated acceptance criteria are unsatisfiable, not merely hard.** Ordered by length, the
required columns overlap:

- longest input required to be REJECTED: `Detailed findings from my review:` — 33 characters
- shortest input required to be ACCEPTED: `OK.` — 3 characters

Any rule monotone in length — a character floor, a word count, a task-size ratio, a token count —
needs a threshold that is simultaneously `<= 3` and `> 33`. No such threshold exists at any scaling
factor. A ratio rule tuned for a small task accepts every heading; tuned for a large one it rejects
**all 574** real reviews. This is why the four attempts failed in both directions: the failure is in
the requirement, not in the implementations.

**4. Token count cannot substitute.** `tokens_used` is absent on **6,052 of 7,723** successful
attempts (78%), including 100% of the `deepseek` transport and 77% of `opencode`. A token floor
would fail open exactly where it is meant to run, and where present it is a length proxy, so point 3
applies to it too. Measured against the 574 real reviews, an 8-token floor falsely rejects 12.

## Why there is no fifth text rule

The validator receives only the response text. A heading and a complete terse
review can have the same text, so no classifier based only on text shape or length
can assign different meanings to identical input. The four attempted rules in
issue #83 demonstrate both error directions:

- a one-letter floor accepts headings and `x`;
- word-count floors reject valid terse and non-Latin reviews while still accepting headings;
- colon-ending rules reject real content that ends with a colon and miss Markdown variants;
- Markdown canonicalisation plus a word threshold moves, rather than removes, both errors.

The other proposed signals do not produce a local non-syntactic fix:

- A `MODEL_OUTPUT` retry can repair a detected violation, but it cannot decide
  whether ambiguous text is a violation without first solving detection.
- Task-to-rationale ratios still need a threshold and do not establish whether a
  short review is reasoned. They recreate the same trade-off at a different input.
- Semantic judgment belongs with the two-step extraction work tracked by #80.
  Implementing that work here would violate #83's scope and add a model call.

Accordingly, the current gate retains the cheap hygiene floor without presenting
it as semantic validation. The load-bearing fail-closed properties remain missing
verdict detection and conflicting-verdict detection.

## Characterisation probe (a PASSING test that records a KNOWN GAP)

Each input below is combined with `VERDICT: APPROVED`; “bare verdict” has no other
content. “Required” is the semantic target from issue #83. “Actual” is the retained
text validator behavior exercised by `ocask.test.mjs`.

| Input | Required | Actual | Requirement met? |
|---|---|---|---|
| bare verdict | REJECT | REJECT | yes |
| `Rationale:` | REJECT | ACCEPT | no |
| `Review summary:` | REJECT | ACCEPT | no |
| `**Review summary:**` | REJECT | ACCEPT | no |
| `Detailed findings from my review:` | REJECT | ACCEPT | no |
| `x` | REJECT | ACCEPT | no |
| `OK.` | ACCEPT | ACCEPT | yes |
| `Correct.` | ACCEPT | ACCEPT | yes |
| `問題ありません。` | ACCEPT | ACCEPT | yes |
| `没有问题。` | ACCEPT | ACCEPT | yes |
| `Well-written.` | ACCEPT | ACCEPT | yes |
| `No issues found.` | ACCEPT | ACCEPT | yes |
| ``Required key is `version:` `` | ACCEPT | ACCEPT | yes |
| `The generated YAML correctly includes the required key: version:` | ACCEPT | ACCEPT | yes |
| `Review summary:` followed by `The implementation preserves the required behavior.` | ACCEPT | ACCEPT | yes |

This result satisfies every required acceptance case and has five false accepts.

**The committed test PASSES.** It is not a failing or skipped test, and calling it a
"failing probe" would be wrong: it asserts the behaviour the validator *actually has*,
and separately records which rows differ from the semantic target. A future semantic fix
changes the recorded mismatches; nothing here is red waiting to go green.

It is evidence for the negative result, not a claim that the semantic requirement has been
implemented. No runtime acceptance or rejection changed in this decision — only the failure
diagnostic, a code comment, this record, and the characterisation test.

## Status of #83

This work does **not** close #83. It removes a false claim and pins the current behaviour;
the underlying defect — a verdict accepted with no reasoning attached — remains.

#83 stays **open, blocked on #80**. Semantic detection needs something that reads the review,
and #80's two-step extraction is already paying for a reader, so "no reasoning present" is
nearly free there and impossible here. Two independent reviewers reached this conclusion
separately, and both objected to this work being presented as a fix. They were right.
