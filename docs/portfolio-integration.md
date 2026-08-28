# Portfolio integration contract

This document maps the fixed Pi fork into the workspace portfolio. It does not change upstream Pi
ownership, MemSWE benchmark meaning, or claim a shipped Ultimate Harness or Telar connection.

## Role and maturity

| Classification | Current status |
|---|---|
| Primary role | Execution Adapter for the current MemSWE runtime |
| Secondary role | Memory adapter host and raw benchmark artifact producer |
| Benchmark authority | Sibling `../memswe` |
| Native system of record | Ignored `.memswe-runs/<timestamp>/<task-id>/` artifacts and optional Langfuse OTLP traces |
| Portfolio integration | Proposed; current runner is invoked directly, not through Ultimate Harness or Telar |

The runner defaults to the faux provider. Real-model or provider-memory modes require explicit
authorization and must not be inferred from the existence of adapter code.

## Native receipt

| Category | Current evidence | Limit |
|---|---|---|
| Run and workload | `run-record.json`, task/condition/repetition/session IDs | `uam-run.v0.1` comes from the sibling schema |
| Model/provider | `condition.model_id` plus `agent-result.json` provider/model/base URL and mode | The schema has no separate harness-version field |
| Harness | Repository revision, runner path, CLI arguments, and Pi package state | Must be retained beside the run; not yet one canonical version field |
| Quality | Verifier results, reward, trace predicates, patches, and changed files | Faux-agent verifier passes are plumbing evidence, not model-quality evidence |
| Cost/tokens | `agent-result.json` and `metric_vector` | Unknown provider values must be `null`; zero is valid only when the run truly incurred none |
| Latency | Agent session, verifier, end-to-end, and memory-retrieval measurements | Record measurement scope and clock source |
| Traces | Local trace artifact/export result and optional Langfuse trace ID | A configured exporter or local file does not by itself prove remote ingestion |

Hidden and protected verifier bodies remain harness-side. Portfolio receipts may expose command
metadata, counts, outcomes, and restricted artifact references, never the protected content.

## Blind-review limits

MemSWE's deterministic checks own task success. If an allowed qualitative judge is added, its
condition and model/provider identity must be blinded and its judge model, rubric, prompt/payload
hash, output, and post-processing retained. Behavioral or prose clues can still reveal identity;
the receipt records that limit rather than claiming perfect blinding.

## Portfolio seam

1. `pi-memswe` owns runtime execution, memory adapter lifecycles, raw artifacts, and trace export.
2. `memswe` owns task, condition, verifier, scoring, and run-record semantics.
3. A future Ultimate Harness adapter may launch/cancel/observe one bounded Pi run and link attempt
   lineage to its native run ID; it must not reinterpret scores or memory conditions.
4. The proposed Telar layer may supply authorization and comparison policy and consume normalized
   evidence references. It is not currently wired to this runner.

## Future plan

- Add an executor-owned receipt manifest containing repository revision, runner version, exact
  arguments, configuration hash, resolved provider/model, artifact hashes, and trace-export status.
- Replace default numeric zeroes with explicit unknown/null where a real provider did not report a
  cost, token, or operation metric.
- Implement a versioned Ultimate Harness adapter only after the shared execution/evidence contract
  is accepted; keep direct smoke commands as the local diagnostic path.
