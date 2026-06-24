> **STATUS 2026-06-24:** P0 (default-on export when Langfuse env present) is **IMPLEMENTED + VERIFIED** in this change — the runner auto-exports every run to Hermes with no `--otel-trace` flag (verified live: `flush` → exported, trace ingested into project Hermes, `otel_trace_complete: pass`). A `--no-otel-trace` opt-out exists. P1–P4 remain.

# MemSWE -> Langfuse trace export: integration roadmap

Reader: MemSWE harness maintainers. Post-read action: turn the existing OTLP scaffold into default unattended trace export for every benchmark run into Langfuse project **Hermes** in org **Agentic Engineering**.

## 1. Current state: what exists and what was just verified

Langfuse is live at `https://langfuse.agenticengineering.lat` on v3.194.0. The target OTLP endpoint is:

```text
https://langfuse.agenticengineering.lat/api/public/otel/v1/traces
```

The supplied Langfuse keys map to project **Hermes** under org **Agentic Engineering**. Earlier 403/404 blockers are no longer the expected state; the endpoint is now reachable and should be treated as the production trace sink.

On `pi-memswe` main, the harness already has the trace-export foundation:

- `memswe-trace-scaffold.ts` contains a flag-gated OTLP/HTTP-JSON exporter.
- `resolveMemSweOtlpExporterConfig` reads `LANGFUSE_OTLP_ENDPOINT`, falling back to `OTEL_EXPORTER_OTLP_ENDPOINT`.
- `resolveLangfuseBasicAuthHeader` builds `Basic base64(LANGFUSE_PUBLIC_KEY:LANGFUSE_SECRET_KEY)`.
- `exportOtlpTrace` POSTs OTLP JSON to `/api/public/otel/v1/traces` using `resourceSpans` and `scopeSpans`.
- Trace IDs are 16 bytes and span IDs are 8 bytes, matching OTLP expectations.
- Current span kinds cover `benchmark`, `memory`, `verifier`, and `scoring`.
- Span attributes with secret-like names are scrubbed before export.

The runner already creates useful coarse spans:

- `benchmark.run`
- `memory.prepare`
- `verifier.<kind>`
- `scoring.reward`

It calls `trace.flush()` per run, which is the right place to make export reliable and bounded. The important limitation is activation: tracing only runs when `--otel-trace` is passed.

## 2. Gaps

1. **Not every run exports.** Trace export is opt-in behind `--otel-trace`; unattended runs without the flag produce no Langfuse trace.
2. **Live ingestion needs an explicit acceptance test.** The exporter exists, and the endpoint is reachable, but the harness should verify that a real run creates a visible trace in Hermes.
3. **Runtime environment is incomplete.** Deploy, CI, and benchmark-run environments do not yet have `LANGFUSE_OTLP_ENDPOINT`, `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_SECRET_KEY` wired consistently.
4. **Spans are too coarse for benchmark analysis.** Current spans do not include per-model token counts, cost, detailed memory operations, or adapter-level boundaries for Mem0, Letta, Graphiti, and future memory systems.
5. **Run records are not trace-linked.** A run artifact cannot currently point a reader from `trace_store_ref` to the corresponding Langfuse trace URL.
6. **Routing is single-project only.** The near-term target is Hermes, but future multi-condition or multi-tenant runs may need per-org/project routing.

## 3. Phased plan

### P0 — Enable and verify every-run export

Goal: if Langfuse env vars are present, every harness run exports by default.

- Change the runner's trace activation rule from “only when `--otel-trace` is passed” to “enabled when Langfuse/OTLP env is configured.”
- Keep `--otel-trace` as an explicit force-on flag for local debugging.
- Add a clear opt-out for local/no-network runs, for example a runner flag or env var that disables export even when inherited env vars exist.
- Keep fail-safe behavior strict enough to surface configuration errors: missing public/secret key or endpoint should disable tracing with an explicit warning or fail in CI, depending on run mode; it must not silently claim export happened.
- Run one minimal MemSWE smoke run with Langfuse env present.
- Verify `trace.flush()` posts to `https://langfuse.agenticengineering.lat/api/public/otel/v1/traces` and that the trace appears in Hermes with the expected `benchmark.run`, `memory.prepare`, verifier, and scoring spans.
- Record the observed trace ID and the run artifact path for the rollout note.

### P1 — Wire deploy, CI, and run environments

Goal: unattended benchmark execution always has the Hermes trace sink configured.

- Store `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` as secrets in the environments that run the harness. Do not hardcode them in source or run records.
- Set `LANGFUSE_OTLP_ENDPOINT` to the Hermes OTLP endpoint in those same environments.
- Confirm local developer instructions prefer shell/env injection, not checked-in `.env` files.
- Add a preflight check before benchmark execution that reports whether export is enabled, which endpoint is selected, and whether credentials are present without printing secret values.
- For CI, decide whether missing Langfuse env should fail the run or merely mark trace export unavailable. For the “export every trace” target, scheduled/official benchmark jobs should fail fast when the env is absent.

### P2 — Add richer spans and attributes

Goal: make traces useful for diagnosis, cost review, and memory-system comparison.

- Add benchmark-level attributes on `benchmark.run`: task id, condition id, model id, agent mode, reward/status, visible/protected counts, changed-file count, and run artifact path.
- Add model usage attributes when available: prompt tokens, completion tokens, total tokens, provider/model name, latency, and cost. Do not fabricate values; omit unknown values.
- Split coarse memory work into per-memory-operation spans, such as load facts, select context, write observation, persist summary, and retrieve prior state.
- Add adapter-specific spans for Mem0, Letta, Graphiti, and any future adapters so trace comparisons show where each memory backend spends time or fails.
- Preserve secret scrubbing for all new attributes and extend tests to cover new secret-like attribute names.

### P3 — Link run records and define Hermes views

Goal: run artifacts and Langfuse become mutually navigable.

- Populate each run record's `trace_store_ref` with the Langfuse trace URL once export succeeds.
- Use a deterministic URL format based on the exported trace ID, after confirming the exact Langfuse trace URL shape in Hermes.
- If export fails, record a structured trace export error state rather than a fake URL.
- Add Hermes dashboards for benchmark runs by task, condition, model, adapter, reward/status, latency, and token/cost totals.
- Define Hermes evaluations that match MemSWE review needs: failed verifier spans, memory preparation failures, high-cost runs, and runs with missing scoring spans.

### P4 — Multi-condition and per-org/project routing

Goal: support future benchmark routing without cloning exporter logic.

- Keep Hermes as the default route for Agentic Engineering's MemSWE runs.
- Add a routing layer that can select endpoint and credentials per benchmark suite, org, project, or condition when those concepts need separate Langfuse projects.
- Ensure routing never mixes secrets across projects. Each route should read a named endpoint/public-key/secret-key set from environment or secret storage.
- Include route identity as a non-secret resource attribute so traces can be filtered by source environment and benchmark suite.

## 4. “Export EVERY trace” checklist

- [ ] Default-on tracing when `LANGFUSE_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` plus Langfuse keys are present.
- [ ] Explicit opt-out exists for local/offline runs.
- [ ] Official CI/scheduled benchmark jobs fail fast when required Langfuse env is missing.
- [ ] `trace.flush()` runs once per benchmark run and surfaces export failure.
- [ ] A live smoke trace lands in Hermes and contains benchmark, memory, verifier, and scoring spans.
- [ ] Run records include `trace_store_ref` only after successful export.
- [ ] Secret-like span attributes remain scrubbed.
- [ ] New model, memory-operation, and adapter spans omit unknown values rather than inventing them.
- [ ] Dashboards/evaluations in Hermes can answer: what failed, where time was spent, and what each run cost.

## 5. Env-var reference

```text
LANGFUSE_OTLP_ENDPOINT=https://langfuse.agenticengineering.lat/api/public/otel/v1/traces
LANGFUSE_PUBLIC_KEY=<Hermes project public key>
LANGFUSE_SECRET_KEY=<Hermes project secret key>
```

Notes:

- `LANGFUSE_OTLP_ENDPOINT` is preferred by the harness.
- `OTEL_EXPORTER_OTLP_ENDPOINT` remains a fallback endpoint variable.
- The Authorization header is `Basic base64(LANGFUSE_PUBLIC_KEY:LANGFUSE_SECRET_KEY)`.
- Never write key values to run records, logs, public showcase data, or repository files.

## 6. Open questions

1. What exact flag/env name should disable tracing for local offline runs when Langfuse env vars are present?
2. Should official CI fail hard on missing Langfuse env immediately, or only scheduled benchmark jobs?
3. What is the confirmed Hermes trace URL format for deep-linking `trace_store_ref` from run records?
4. Which token and cost fields are available from each current model provider, and which should be omitted until providers expose them?
5. What adapter span taxonomy should Mem0, Letta, Graphiti, and future memory backends share so dashboards compare them fairly?
6. When should routing split beyond Hermes: by condition, benchmark suite, customer org, or deployment environment?
