# Changelog

Harness/scaffolding changes for the PAP-membench MemSWE fork of `pi`. This tracks `pi-memswe`-local work (`packages/coding-agent/scripts/memswe-*.ts`, `packages/coding-agent/test/suite/memswe-smoke-runner.test.ts`), not vendored upstream `pi` changes — see `packages/coding-agent/CHANGELOG.md` for those.

## [Unreleased]

### Added

- Langfuse OTLP/HTTP JSON trace export, default-on since [#9](https://github.com/Agentic-Engineering-Agency/pi-memswe/pull/9). Endpoint resolves from `LANGFUSE_OTLP_ENDPOINT` (falling back to `OTEL_EXPORTER_OTLP_ENDPOINT`); export runs under `--otel-trace`. `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` configure Langfuse auth.
- `hindsight` adapter and lifecycle smoke (`memswe:hindsight-smoke`) as the harness's first real AMS (agentic memory system) target.
- omniroute noted as the preferred model gateway for future real-model runs; the `--agent-mode=omniroute` runner selector itself is planned, not yet implemented.
- 9 harness unit tests covering Python environment setup, verifier asset inference, patch artifacts, run-record validation, scoring, session fallback, report generation, OTel trace scaffold, and task discovery — see `packages/coding-agent/test/suite/memswe-smoke-runner.test.ts`.
- [#17](https://github.com/Agentic-Engineering-Agency/pi-memswe/pull/17) (AMB-47): Graphiti AMS adapter + lifecycle smoke (observe, post-delete miss, settle, self-hosting recipe).
- [#16](https://github.com/Agentic-Engineering-Agency/pi-memswe/pull/16) (AMB-52): Letta AMS adapter + lifecycle smoke (poll, observe, post-delete miss, model metadata).
- [#15](https://github.com/Agentic-Engineering-Agency/pi-memswe/pull/15) (AMB-51): mem0 AMS adapter + lifecycle smoke (poll, observe, post-delete miss).
- [#14](https://github.com/Agentic-Engineering-Agency/pi-memswe/pull/14) (AMB-65): Supermemory reset-safe AMS adapter + lifecycle smoke.
- [#13](https://github.com/Agentic-Engineering-Agency/pi-memswe/pull/13) (AMB-67): LocalRAG (BM25) baseline adapter + smoke.

All adapters above implement the shared `AmsAdapter` contract (`packages/coding-agent/scripts/memswe-adapter-contract.ts`: `reset`/`seed`/`run`) and skip (not fail) their lifecycle smoke when required service env vars (`*_API_URL`, `*_API_KEY`, etc.) are unset.
