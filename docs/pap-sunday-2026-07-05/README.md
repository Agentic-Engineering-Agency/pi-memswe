# PAP delivery evidence index

This directory contains presentation-ready evidence for the MemSWE/PAP-membench delivery at `pi-memswe` commit `7dca44e1`.

## Current evidence

The committed matrix contains 240 cells:

- 10 canonical tasks from the sibling `../memswe` benchmark repository;
- 6 scoped conditions: `no_memory`, `full_context`, `hindsight`, `honcho`, `zep`, and `supermemory`;
- 4 repetitions per task and condition.

All 240 cells report `task_success_visible=1` and `otel_trace_complete=pass`. The first result is a saturated visible-only signal; the second confirms harness trace completeness and successful trace flush. Neither establishes hidden-test success or task-specific memory correctness.

## Deliverables

- [`charts/README.md`](charts/README.md): data-source notes, aggregate table, and limitations.
- [`charts/memswe-cell-matrix.csv`](charts/memswe-cell-matrix.csv): one normalized row per matrix cell.
- [`charts/memswe-aggregate-by-system.csv`](charts/memswe-aggregate-by-system.csv) and [`charts/memswe-aggregate-by-system.json`](charts/memswe-aggregate-by-system.json): per-condition aggregates.
- [`charts/chart-success-rate.png`](charts/chart-success-rate.png): visible-success ceiling across conditions.
- [`charts/chart-latency.png`](charts/chart-latency.png): mean and median task latency.
- [`charts/chart-cost-tokens.png`](charts/chart-cost-tokens.png): mean cost and input/output tokens.
- [`charts/memswe-flow-diagram.md`](charts/memswe-flow-diagram.md): harness execution flow.

## Interpretation limits

- Hidden success is unsupported by the committed matrix evidence.
- RAM/peak-memory usage was not measured.
- The current runner emits sibling-defined task trace predicates as `not_evaluable`; `otel_trace_complete` is a separate diagnostic predicate.
- Aggregate injected-memory share is zero, so the matrix cannot support memory-utilization claims.
- `full_context` prepends prior transcripts, and Honcho has an explicit graded recall/readback path. The generic Hindsight, Zep, and Supermemory condition paths record provider lifecycle probes but do not generally inject provider recall into the graded prompt.
- Comparisons are valid only when model, prompt template, tools, fixture visibility, verifier policy, repetition policy, and scoring remain fixed while the memory condition changes.

Benchmark definitions, task assets, verifier policy, and run-record schema remain owned by the sibling `../memswe` repository. This repository owns the pi execution harness, condition adapters, trace capture, and exported delivery artifacts.
