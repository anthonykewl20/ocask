# Issue 87: Eval/product verdict parser agreement

## Decision

The eval harness imports `extractVerdict` from `ocask.mjs`. The product helper is the
single authority for whether model reply text carries an `APPROVED`, `WARNING`, or
`BLOCKED` verdict.

Keeping an independent eval parser was rejected. A reply the product rejects is still
observable to the harness as `parse_ok: false`; it is not honest to turn that rejected
reply into a judgment merely to count it. If a future evaluation needs to distinguish
conflicting verdict lines from replies with no verdict, that must be recorded under a
separate diagnostic field rather than changing the meaning of `verdict`.

`parseVerdict` still unwraps recorded CLI envelopes and JSON strings because that is an
offline record-format concern, not a second definition of verdict syntax. Once it reaches
either a text reply or an object carrying a verdict, it delegates the decision to
`extractVerdict`. Payloads take precedence over their display text so a recorded CLI
envelope's authoritative top-level verdict wins.

Importing `ocask.mjs` does not run the CLI: `main()` is guarded by `isMainModule()`. An
isolated import probe also confirmed that importing the module creates no data files.

## Drift guard

`eval/parse.test.mjs` compares the harness with `extractVerdict` over a corpus containing
a mid-sentence mention, Markdown wrapping, conflicting verdicts, repeated agreeing
verdicts, a verdict below the fifth nonempty line, and no verdict. Because the harness
calls the product helper and the test exercises their relationship, future drift is made
both structurally impossible at the text-parsing seam and loud at the test seam.

## Existing baseline

Existing baseline metrics produced under the former substring rule are methodologically
affected: `verdict`, `parse_ok`, comparability, and downstream scoring could count replies
that the product rejects. This change does not re-measure or rewrite the frozen baseline;
those figures should be treated as potentially stale until a separately authorized live
measurement is performed.

## Related eval audit

No other eval module parses verdict syntax independently. `arm.mjs`, `golden.test.mjs`,
and `metrics.mjs` consume `parseVerdict`; `metrics.mjs`, `arm.mjs`, and `schema.mjs` also
validate already-structured verdict or expected-value enums, which is a different
boundary and does not reinterpret model reply text. Scoring and panel classification are
centralized in `metrics.mjs`; the audit found no duplicate product classification parser.
