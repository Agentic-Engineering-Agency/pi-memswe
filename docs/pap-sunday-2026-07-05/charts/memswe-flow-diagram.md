# MemSWE Benchmark Harness — Flow Diagram

Central flow for the MemSWE 240-cell matrix (10 canonical tasks x 6 conditions x 4 reps).
Verified by AGE-186: 240/240 `otel_trace_complete=pass`, `task_success_visible=1`.

```mermaid
flowchart LR
  T([Task spec<br/>10 canonical]) --> V{Validate<br/>preflight}
  V -->|fail| X[Abort cell<br/>record error]
  V -->|ok| I[Isolate<br/>per-repo bank + session]
  I --> E[Execute<br/>agent x condition<br/>no_memory / full_context /<br/>hindsight / honcho / zep / supermemory]
  E --> C[Collect<br/>OTel trace + metric_vector]
  C --> CL[Cleanup<br/>tear down bank/session]
  CL --> EV{Evaluate<br/>trace predicates<br/>+ task_success_visible}
  EV -->|pass| D[(Dashboard<br/>aggregate CSV/JSON<br/>+ charts)]
  EV -->|fail| X
  X --> D

  classDef term fill:#607d8b,stroke:#333,color:#fff;
  classDef gate fill:#ff9800,stroke:#333,color:#fff;
  classDef work fill:#3f51b5,stroke:#333,color:#fff;
  classDef out fill:#009688,stroke:#333,color:#fff;
  class T,X term;
  class V,EV gate;
  class I,E,C,CL work;
  class D out;
```

## Stage legend

| Stage | What happens | Evidence key |
|-------|--------------|--------------|
| Validate | Local smoke / preflight per adapter | `error.failed_phase=preflight` on abort |
| Isolate | Fresh memory bank + graded session per cell | `condition.baseline_kind`, `bank_id` |
| Execute | Agent runs task under one memory condition | `session_results`, `run_id` |
| Collect | Emit OTel trace + `metric_vector` | `output_locations.trace_store_ref` |
| Cleanup | Tear down bank/session state | (idempotent teardown) |
| Evaluate | Trace predicates + visible success | `trace_predicate_results[otel_trace_complete]` |
| Dashboard | Aggregate to CSV/JSON + charts | this directory |
