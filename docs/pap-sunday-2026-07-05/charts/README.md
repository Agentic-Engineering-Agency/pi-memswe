# MemSWE Charts & Flow Diagram (AGE-232)

DeepSWE-style visuals built from the verified 240-cell matrix (AGE-186:
10 canonical tasks x 6 conditions x 4 reps = 240 cells; all
`otel_trace_complete=pass`, `task_success_visible=1`). Drop-in for the RPAP
report/poster (feeds AGE-214).

## Data source
Latest `run-record.json` per `(task_id, condition_id, repetition_index)` cell
under `.memswe-runs`, filtered to the 6 scoped conditions and reps 1-4
(rep 98/99 sanity runs excluded).

## Files
- `chart-success-rate.png` — visible success rate by system.
- `chart-latency.png` — mean + p50 per-task latency by system.
- `chart-cost-tokens.png` — avg cost + avg tokens (input/output) by system.
- `memswe-flow-diagram.md` — central mermaid flow (task -> validate -> isolate
  -> execute -> collect -> cleanup -> evaluate -> dashboard).
- `memswe-cell-matrix.csv` — 240 per-cell rows.
- `memswe-aggregate-by-system.csv` / `.json` — per-system aggregates.

## Signal caveat (for limitations section)
All 6 conditions show **1.00 visible success** (240/240). The visible-success
metric does **not discriminate** between baselines and memory systems on this
task set — it is saturated at the ceiling. Discrimination, if any, must come
from the secondary axes (latency, cost, tokens), where systems do differ
(e.g. `zep` slowest at ~23.0s mean; `supermemory` cheapest at ~0.000086 USD
(~86 µUSD); `full_context` lowest latency at ~3.8s mean).

## Aggregate summary (per system, n=40)
| system | success | mean lat (s) | p50 lat (s) | cost (USD) | tot tokens |
|--------|---------|--------------|-------------|------------|------------|
| no_memory | 1.00 | 20.4 | 6.5 | 0.000122 | 599 |
| full_context | 1.00 | 3.8 | 2.8 | 0.000118 | 716 |
| hindsight | 1.00 | 18.8 | 5.9 | 0.000113 | 567 |
| honcho | 1.00 | 14.5 | 5.0 | 0.000109 | 649 |
| zep | 1.00 | 23.0 | 12.9 | 0.000145 | 678 |
| supermemory | 1.00 | 15.0 | 11.1 | 0.000086 | 470 |
