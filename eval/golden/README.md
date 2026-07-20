# Golden output fixtures

These fixtures are synthetic-but-format-faithful stand-ins for `ocask` output shapes used for parser and metric smoke tests. They are pending a real capture from current production run tooling.

## Regeneration

1. Re-run `eval/golden.test.mjs` to confirm parser/metric behavior.

Fixture filenames correspond to verdict classes:

- `approved.json`
- `warning.json`
- `blocked.json`
- `truncated.json`
