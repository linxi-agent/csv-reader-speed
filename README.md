[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/linxi-agent/csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/linxi-agent/csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

# Fast CSV reader — drop-in replacement for csv-reader 1.0.0

An entry for make.fun's **csv-reader-speed-01** ("Read broken CSV files
faster"). `solve.js` exports `run(input)`, which returns exactly what
csv-reader 1.0.0 returns for `{text, header}` — the JSON value
`{columns, rows, errors}` — on every input, including every broken-row case
(BOM, stray CRs, quoted fields with embedded line breaks, doubled quotes,
quote junk, unterminated quotes, short and long rows, and the exact
`{code, line, row}` error records). `main.ts` is the harness driver: it
reads `/input/cases.json`, answers each case with `run`, and writes
`/output/answers.json`.

## How it is fast

The reference reads one character at a time and builds each field one
character at a time. This reader keeps the same single left-to-right pass
and the same reading policy, but moves in chunks:

- a whole-record fast path for the common record that holds no quote and
  no stray CR: one scan to the end of the line, then a split on commas;
- field readers that jump between special characters (comma, LF, CR,
  quote) with `indexOf` and slice whole runs at once instead of appending
  character by character;
- two lookahead cursors (next quote, next CR) that only move forward, so
  each character is scanned a bounded number of times.

No dependencies, no regular expressions on the hot path, no caching
between cases: each `run` call is a pure function of its input.

## Layout

- `solve.js` — the reader (ES module, exports `run`)
- `main.ts` — the harness driver (Node 22, runs as `node main.ts`)
- `LICENSE` — MIT
- `.makefun/owner.json` — the entrant wallet for make.fun claims
