# MemSWE MemoryBench adaptation design

This note maps MemoryBench concepts into MemSWE/pi-memswe for Eduardo's PAP-membench thesis work. It is intentionally design-only: coding benchmarks need a different pipeline than conversational QA, and implementation should start with traceable harness surfaces rather than speculative provider code.

## Current implementation note

This document is the original adaptation design. Current implemented smoke/report surfaces are documented in `packages/coding-agent/README.md` and `packages/coding-agent/docs/memswe-benchmark-status.html`. As of `3bc74d7c`, `memswe:smoke` emits smoke artifacts/run records and `memswe:report` aggregates ignored `.memswe-runs/**` artifacts into static reports.

Since then, the harness has grown: OTLP trace export to Langfuse is default-on (env-gated via `LANGFUSE_OTLP_ENDPOINT`/`LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`, see `README.md`'s "Observability & model gateway" section); `hindsight` is the first real AMS target with a dedicated smoke script (`memswe:hindsight-smoke`); and the shared `AmsAdapter` contract (`memswe-adapter-contract.ts`) now has implementations for `graphiti`, `letta`, `mem0`, `supermemory`, and `localrag` (BM25 baseline), each with its own env-gated lifecycle-smoke script that skips rather than fails when unconfigured. omniroute is the intended model gateway for future real-model runs; the `--agent-mode=omniroute` selector itself has not landed yet.

## Source references inspected

MemoryBench reference repo (`../memorybench-memswe`):

- `src/types/benchmark.ts` defines the benchmark abstraction: load questions, haystack sessions, ground truth, and question types.
- `src/types/unified.ts` defines unified sessions/questions, search results, evaluation results, latency, token, retrieval, and report aggregates.
- `src/types/provider.ts` defines the provider contract: initialize, ingest sessions, await indexing, search, clear.
- `src/types/checkpoint.ts` defines phase IDs and run/question checkpoints for `ingest -> indexing -> search -> answer -> evaluate -> report`.
- `src/orchestrator/index.ts` wires benchmark, provider, judge, phase execution, checkpoint resume, and reporting.
- `src/orchestrator/checkpoint.ts` persists run checkpoints under `data/runs/<runId>/checkpoint.json` and stores per-question phase status.
- `src/orchestrator/phases/{ingest,search,answer,evaluate,report}.ts` implement the MemoryBench pipeline.
- `src/providers/filesystem/index.ts` shows the useful baseline pattern: a provider can be simple if its inputs/outputs are normalized and observable.

MemSWE source repo (`../memswe`):

- `schema/uam-task.schema.json` defines task folders, session sequences, facts, scopes, verifiers, diffs, trace predicates, and metrics.
- `schema/run-record.schema.json` defines one normalized run record per `(task, condition, model, repetition)` with session results, reward, metric vector, trace predicates, primary failure category, and artifact locations.
- `docs/architecture.md` defines the four-layer benchmark/runtime/task/memory topology and the adapter-facing responsibilities.
- `docs/measurement.md` defines required result views, metric catalog, instrumentation, Hindsight pilot fields, and pilot policy.
- `docs/scoring.md` defines deterministic-first scoring, judge limits, score vector, repetitions, and failure precedence.
- `tasks/repo-gamma-invoice-export-001/task.yaml` shows the actual task shape: multi-session coding history, lifecycle facts, visible/hidden/protected tests, diff constraints, trace predicates, and metric names.

pi-memswe repo (`.`):

- `packages/coding-agent/docs/sdk.md` documents `createAgentSession`, `AgentSession.prompt`, event subscription, `SessionManager`, and runtime/session replacement APIs.
- `packages/agent/docs/agent-harness.md` documents harness turn snapshots, save points, tools, sessions, hooks/events, and deterministic persistence constraints.
- `packages/ai/src/types.ts` and `packages/agent/src/agent-loop.ts` contain the tool/message primitives that a MemSWE harness should observe rather than bypass.

## 1. Clean mappings from MemoryBench to MemSWE

| MemoryBench concept | Clean MemSWE adaptation |
| --- | --- |
| `Benchmark` | `TaskSuite` / dataset loader over MemSWE task folders. Load `task.yaml`, `instruction.md`, `sessions/*.md`, fixture, verifier metadata, facts, diffs, and trace predicates. |
| `UnifiedSession` | `MemSWE session prompt/history item`, but with coding metadata: `task_id`, `session_id`, `role`, `prompt_ref`, `revealed_facts`, allowed tools, stop condition, graded flag, fixture state, and scope labels. |
| `UnifiedQuestion` | `MemSWE task attempt`, not a QA question. The query/goal is the current session prompt plus task descriptor and repository state. Ground truth is verifier/diff/trace expectations, not a free-text answer. |
| Provider `ingest()` | Memory-condition `seed` / `observe prior session` / `retain` stage. Ingest synthetic session histories, facts, repo docs, or previous-session artifacts into a scoped memory bank. |
| Provider `awaitIndexing()` | `await_settle()` for async memory consolidation/indexing after retain, update, delete, or doc-baseline writes. Emit settle time and timeout status. |
| Provider `search()` | `recall()` / context-injection boundary. Return normalized retrieved memory items and injected text before or during an agent turn. |
| Provider `clear()` | `reset(scope)` before every repetition and condition. Must clear project/user/domain/run memory banks as declared. |
| Checkpoints | Same resumability idea, but keyed by task, condition, repetition, and session rather than per question. |
| Retrieval metrics | Keep diagnostic retrieval/usefulness metrics, but never let retrieval scores replace tests, diffs, or trace predicates for task success. |
| Reports | Keep normalized JSON reports, but align with `run-record.v0.1` and MemSWE measurement views instead of `accuracy`/`MemScore`. |

Useful MemoryBench ideas to retain:

1. Provider isolation through a small interface.
2. Phase checkpoints with resume-safe status and artifact paths.
3. Normalized provider outputs so black-box and white-box memory systems can be compared.
4. Separate raw per-item artifacts from aggregate reports.
5. Latency, token, and context-size accounting near every memory boundary.

## 2. Abstractions that must be replaced

Conversational QA assumptions in MemoryBench should not carry over unchanged:

- `question`, `groundTruth`, and `hypothesis` are too narrow. MemSWE's outcome is a repository patch plus verifier/test/diff/trace evidence.
- `haystack sessions` as chat logs are insufficient. MemSWE history includes prior coding sessions, repo changes, diagnoses, corrections, forget/supersede events, and memory scopes.
- `answer` phase should not call an answer model with retrieved context. The coding agent runtime is the SUT execution path; it must run tools, edit files, and produce artifacts under fixed runtime constraints.
- `evaluate` must not be judge-first. MemSWE uses deterministic-first scoring: visible/hidden/protected tests, diffs, state checks, trace predicates, counters, and only narrowly allowed judges.
- `SearchResult = unknown` is too loose for thesis reporting. Retrieved/injected memories must have stable IDs, scope, provenance, lifecycle status, token counts, timings, and use evidence.
- `containerTag` should become explicit `scope_id` / `memory_bank_id` / `run_id` / `condition_id`, because leakage and scope isolation are first-class outcomes.
- `MemScore` should not be used as the headline. MemSWE reports a vector and leaderboard ordering by success then cost, with no hidden composite.

## 3. Proposed MemSWE/pi-memswe phase pipeline

The equivalent of MemoryBench's `ingest -> indexing -> search -> answer -> evaluate -> report` should be:

1. `load_task`
   - Validate `task.yaml` against `schema/uam-task.schema.json`.
   - Resolve fixture, session prompts, facts, scopes, verifier commands, diff constraints, and trace predicates.

2. `materialize_fixture`
   - Copy the repository fixture into an isolated working directory/container.
   - Apply base state and enforce hidden/protected assets outside the agent-visible fixture.

3. `reset_condition`
   - Reset memory state for `(task_id, condition_id, repetition_index, scope)`.
   - For no-memory and baselines, reset the equivalent state: context policy, docs folder, transcript replay buffer.

4. `seed_history`
   - Seed declared `seeded_history` and prior sessions that apply to the condition.
   - For repository-docs baseline, write allowed session-derived facts into `docs/agent-project-memory/`.
   - For AMS providers, call retain/seed APIs with lifecycle metadata.

5. `await_memory_settle`
   - Poll or wait for async indexing/consolidation after seed/update/delete.
   - Emit `memory_consolidation_settle_time_ms` and timeout/error details.

6. `run_session_sequence`
   - For each `memswe.session_sequence` entry, run the fixed pi coding-agent runtime with the declared prompt, tools, visible context policy, and memory condition.
   - Capture final response, file diffs, tool calls, model usage, injected memories, memory calls, trace IDs, and artifacts.
   - Stop according to `stop_condition` (`diagnosis_only`, `patch_required`, `summary_only`, `verifier_attempt`).

7. `verify_artifacts`
   - Run visible/hidden/protected verifier commands in the separate verifier environment.
   - Compute F2P/P2P, apply-failed, partial score, visible/hidden success, and protected-test regressions.

8. `score_memory_behavior`
   - Evaluate trace predicates (`uses_memory`, `avoids_repeat`, `no_leakage`, `no_stale_use`, `scope_isolation`).
   - Compute stale-use, leakage, repeated-action, utilization, retrieval latency, injected-memory tokens, context-token reduction, and trace coverage.

9. `emit_run_record`
   - Emit `schema/run-record.schema.json` compatible output plus artifact refs.
   - Preserve raw traces, retrieved-memory items, verifier logs, patch files, and scoring evidence.

10. `aggregate_report`
   - Aggregate per condition/task/language/task-type/repetition for the five required result views in `../memswe/docs/measurement.md`.

## 4. Checkpoint shape

Checkpoint files should be resume-safe and artifact-oriented. Recommended path:

```text
runs/<run_id>/checkpoint.json
runs/<run_id>/tasks/<task_id>/<condition_id>/rep-<k>/artifacts/...
```

Recommended checkpoint skeleton:

```json
{
  "schema_version": "memswe-checkpoint.v0.1",
  "run_id": "pilot-001",
  "created_at": "2026-06-16T00:00:00.000Z",
  "updated_at": "2026-06-16T00:00:00.000Z",
  "status": "running",
  "suite": {
    "task_ids": ["repo-gamma-invoice-export-001"],
    "conditions": ["no_memory", "full_context", "repository_docs", "hindsight"],
    "model_id": "fixed-model-id",
    "repetitions": 4
  },
  "attempts": {
    "repo-gamma-invoice-export-001:hindsight:1": {
      "task_id": "repo-gamma-invoice-export-001",
      "condition_id": "hindsight",
      "model_id": "fixed-model-id",
      "repetition_index": 1,
      "scope_ids": ["project:repo-gamma-invoice-export-001"],
      "memory_bank_ids": ["hindsight:project:repo-gamma-invoice-export-001:rep-1"],
      "phases": {
        "load_task": { "status": "completed", "artifact_paths": { "task_yaml": "..." } },
        "materialize_fixture": { "status": "completed", "artifact_paths": { "workdir": "..." } },
        "reset_condition": { "status": "completed" },
        "seed_history": { "status": "completed", "memory_item_ids": ["..."] },
        "await_memory_settle": { "status": "completed", "duration_ms": 1200 },
        "run_session_sequence": { "status": "completed", "session_ids": ["s1", "s2", "s3"] },
        "verify_artifacts": { "status": "completed", "artifact_paths": { "verifier_log": "..." } },
        "score_memory_behavior": { "status": "completed", "artifact_paths": { "scoring_evidence": "..." } },
        "emit_run_record": { "status": "completed", "artifact_paths": { "run_record": "..." } }
      },
      "sessions": {
        "s3": {
          "status": "completed",
          "trace_id": "otel-trace-id",
          "artifact_paths": {
            "transcript": "...",
            "patch": "...",
            "tool_calls": "...",
            "retrieved_memories": "..."
          }
        }
      }
    }
  }
}
```

Key differences from MemoryBench checkpoints:

- Attempt key includes `task_id`, `condition_id`, and `repetition_index`.
- Per-session artifacts are first-class because sessions may be ungraded but memory-relevant.
- Memory bank IDs and scope IDs are explicit for leakage/scope checks.
- Result files include patches, verifier logs, traces, and normalized retrieved-memory items, not just search JSON.

## 5. Normalized retrieved-memory item schema

Use a stable, diagnostic schema for both retrievals returned by memory tools and memories injected into the prompt. This should be emitted as JSONL per session/turn and referenced by run records.

```ts
interface MemSWERetrievedMemoryItem {
  schema_version: "memswe-retrieved-memory.v0.1";
  run_id: string;
  task_id: string;
  condition_id: string;
  repetition_index: number;
  session_id: string;
  turn_id: string;
  memory_system: string | null;
  memory_bank_id: string | null;
  memory_item_id: string | null;
  source_session_id?: string;
  source_fact_ids?: string[];
  scope: "user" | "project" | "repository" | "domain" | "feature" | "task";
  lifecycle: "valid" | "superseded" | "forgotten" | "deleted" | "unknown";
  content: string;
  injected_content?: string;
  retrieval_rank?: number;
  retrieval_score?: number;
  retrieval_query?: string;
  retrieval_latency_ms?: number;
  content_tokens?: number;
  injected_tokens?: number;
  provenance: {
    provider_item_id?: string;
    provider_trace_id?: string;
    created_at?: string;
    updated_at?: string;
    retained_at_session?: string;
  };
  use_evidence?: {
    referenced_by_tool_call_ids?: string[];
    referenced_in_patch_paths?: string[];
    referenced_in_final_answer?: boolean;
    matched_fact_ids?: string[];
  };
  safety_flags?: {
    stale_candidate?: boolean;
    leakage_candidate?: boolean;
    scope_mismatch?: boolean;
  };
}
```

This schema supports black-box providers: fields that are not visible can be `null`/omitted, while boundary evidence (`injected_content`, latency, tokens, provider trace IDs) remains measurable.

## 6. Coding-memory provider interface

MemoryBench's provider contract should become a benchmark-facing memory condition adapter, not a QA search provider.

```ts
interface CodingMemoryProvider {
  name: string;

  initialize(config: CodingMemoryProviderConfig): Promise<void>;

  reset(input: {
    run_id: string;
    task_id: string;
    condition_id: string;
    repetition_index: number;
    scopes: MemSWEScope[];
  }): Promise<ResetResult>;

  seed_memory(input: {
    task: MemSWETaskDescriptor;
    sessions: MemSWESessionSeed[];
    facts: MemSWEFact[];
    scope: MemSWEScope;
  }): Promise<SeedResult>;

  await_settle(input: {
    memory_bank_ids: string[];
    expected_item_ids?: string[];
    timeout_ms: number;
  }): Promise<SettleResult>;

  before_session(input: {
    task_id: string;
    session_id: string;
    prompt: string;
    repo_state_ref: string;
    allowed_tools: string[];
    scope: MemSWEScope;
  }): Promise<MemoryContextResult>;

  observe_turn?(event: AgentTurnEvent): Promise<void>;

  after_session(input: {
    session_id: string;
    transcript_ref: string;
    patch_ref?: string;
    tool_trace_ref: string;
    final_response: string;
  }): Promise<SessionMemoryWriteResult>;

  delete_or_forget(input: {
    target_fact_ids: string[];
    scope: MemSWEScope;
    reason: string;
  }): Promise<ForgetResult>;

  export_trace(input: {
    run_id: string;
    task_id: string;
    condition_id: string;
    repetition_index: number;
  }): Promise<MemoryTraceExport>;
}
```

Adapter rules:

- `before_session` is where recalled/injected memories are captured; it should return normalized `MemSWERetrievedMemoryItem[]` plus any prompt/system-context additions.
- `observe_turn` is optional because some providers only expose boundary APIs; pi should still trace tool calls, model requests, token/cost usage, and final effects.
- `after_session` lets memory systems retain coding-session outputs when the condition allows it.
- `delete_or_forget` is required for tasks with `facts.forget` or supersession checks, even if implemented as a no-op with an explicit unsupported result for baselines.
- Baselines should implement the same interface: no-memory returns empty context, full-context returns transcript replay items, repository-docs returns docs-folder memory items.

## 7. Result/report dimensions for the thesis

The output should align with `../memswe/schema/run-record.schema.json` and `../memswe/docs/measurement.md`:

- Task success: visible and hidden; F2P/P2P/partial/apply-failed where available.
- Deterministic memory hygiene: stale-use rate, leakage count, scope-isolation violations, forbidden stale facts used, required valid facts missed.
- Trace predicates: pass/fail/not-evaluable with evidence refs and blocking/diagnostic severity.
- Cost and latency: per-task cost, end-to-end latency, memory retrieval p50/p95, consolidation settle time.
- Tokens/context: total/input/output/thinking tokens, context tokens required, injected-memory tokens, injected-memory token share, session-bootstrap information.
- Tool/process behavior: memory operation calls by type/share, total tool calls, time to first productive action, repeated failed action count.
- Retrieval/use diagnostics: memory utilization rate, retrieval ranks/scores when visible, retrieved-but-unused items, used-without-retrieval evidence for baselines.
- Reliability: k=4 repetition pass/fail consistency and primary failure category stability.
- Breakdowns: condition, task type, language, session index/cross-session improvement, scope, and lifecycle category (valid/superseded/forgotten/deleted).

Do not report a single MemoryBench-style `accuracy` or `MemScore` as the thesis headline. A small diagnostic string may be useful internally, but public ranking should be task success descending then average cost ascending, with independent sortable columns.

## 8. What to implement first in pi-memswe vs later in memswe

This section is a design/backlog view. Items already partially scaffolded in `pi-memswe` include the smoke runner, artifact/run-record emission, and static report generation; remaining work is to promote those surfaces into full multi-session, per-condition benchmark execution.

### First in `pi-memswe`

1. A thin MemSWE harness runner around `createAgentSession` / runtime APIs that can execute one `task.yaml` session sequence with fixed tools/model/runtime options.
2. Artifact capture: transcripts, patches, tool-call logs, verifier logs, token/cost usage, and trace IDs for each session.
3. A condition adapter interface like `CodingMemoryProvider` with baseline implementations for:
   - `no_memory`,
   - `full_context`,
   - `repository_docs`.
4. Normalized retrieved/injected memory JSONL emission using `memswe-retrieved-memory.v0.1`.
5. Checkpoint/resume support at attempt and session granularity.
6. A `run-record.v0.1` emitter compatible with `../memswe/schema/run-record.schema.json`.
7. Hindsight adapter only after baseline artifact capture is reliable.

### Later in `memswe`

1. Ratify additional schemas for checkpoints and retrieved-memory JSONL once the pi harness proves field coverage.
2. Add dataset-level docs that point to the normalized adapter contract and artifact layout.
3. Add conformance examples using existing tasks such as `repo-gamma-invoice-export-001`.
4. Expand `metrics_to_emit` names if pilot traces show missing fields (for example explicit `memory_retrieval_latency_p95_ms` vs generic `latency`).
5. Add public dashboard/leaderboard ingestion after run records are stable.

## Near-term implementation tasks

1. Define TypeScript types in pi-memswe for `MemSWECheckpoint`, `MemSWERetrievedMemoryItem`, and `CodingMemoryProvider` in an experimental package/module.
2. Implement a single-task dry-run that loads `../memswe/tasks/repo-gamma-invoice-export-001/task.yaml`, materializes its fixture, and emits a checkpoint without calling any paid API.
3. Add no-memory and full-context baseline adapters; verify they emit empty/replay retrieved-memory JSONL respectively.
4. Wrap pi session events/tool execution to emit the minimum trace fields needed by `run-record.v0.1`.
5. Add verifier execution and patch capture; only then integrate Hindsight.
6. Validate emitted run records against `../memswe/schema/run-record.schema.json` in CI/local checks.

## Open design cautions

- Hidden/protected tests must remain outside the agent-visible fixture.
- Memory provider internals are diagnostics, not scoring ground truth.
- Scope IDs must be explicit from the first prototype; retrofitting leakage checks later will be error-prone.
- Repository-docs baseline should be treated as a memory condition, not as uncontrolled extra context.
- Any judged fields must follow `../memswe/docs/scoring.md` and cannot decide task success, stale-use non-use, leakage, cost, latency, tokens, or tool counts.
