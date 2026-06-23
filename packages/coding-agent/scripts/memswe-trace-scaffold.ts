import { createHash } from "node:crypto";

export type MemSweTraceSpanKind = "benchmark" | "memory" | "verifier" | "scoring";

export type MemSweTraceSpan = {
	kind: MemSweTraceSpanKind;
	name: string;
	start_time_ms: number;
	end_time_ms: number;
	duration_ms: number;
	attributes: Record<string, string | number | boolean | null>;
};

export type DisabledMemSweTraceArtifact = {
	enabled: false;
};

export type EnabledMemSweTraceArtifact = {
	enabled: true;
	trace_id: string;
	trace_store_ref: string;
	spans: MemSweTraceSpan[];
	completeness: MemSweTraceCompleteness;
};

export type MemSweTraceArtifact = DisabledMemSweTraceArtifact | EnabledMemSweTraceArtifact;

export type MemSweTraceCompleteness = {
	complete: boolean;
	missingKinds: MemSweTraceSpanKind[];
	traceCoverage: number;
};

export type MemSweMemoryLatencySummary = {
	p50_ms: number | null;
	p95_ms: number | null;
};

export type MemSweTraceExportResult =
	| { status: "disabled" }
	| { status: "skipped"; reason: "endpoint_unset" | "empty_trace" }
	| { status: "exported"; endpoint: string };

type MemSweOtlpExporterConfig = {
	endpoint: string;
	endpointSource: "LANGFUSE_OTLP_ENDPOINT" | "OTEL_EXPORTER_OTLP_ENDPOINT";
};


type TraceSpanHandle = {
	end: (endTimeMs?: number) => void;
};

const REQUIRED_SPAN_KINDS: MemSweTraceSpanKind[] = ["benchmark", "memory", "verifier", "scoring"];
const SECRET_ATTRIBUTE_PATTERN = /(?:secret|token|key|authorization|password)/i;

export type MemSweTraceRecorder = {
	enabled: boolean;
	traceId: string | null;
	traceStoreRef: string | null;
	startSpan: (
		kind: MemSweTraceSpanKind,
		name: string,
		attributes?: Record<string, unknown>,
		startTimeMs?: number,
	) => TraceSpanHandle;
	toArtifact: () => MemSweTraceArtifact;
	flush: () => Promise<MemSweTraceExportResult>;
};

export function createDisabledMemSweTrace(_runId: string): MemSweTraceRecorder {
	return {
		enabled: false,
		traceId: null,
		traceStoreRef: null,
		startSpan: () => ({ end: () => {} }),
		toArtifact: () => ({ enabled: false }),
		flush: async () => ({ status: "disabled" }),
	};
}

export function createEnabledMemSweTrace(
	runId: string,
	startedAtMs = Date.now(),
	exporterConfig = resolveMemSweOtlpExporterConfig(),
): MemSweTraceRecorder {
	const traceId = sanitizeTraceId(runId);
	const spans: MemSweTraceSpan[] = [];
	const traceStoreRef = exporterConfig ? otlpTraceStoreRef(exporterConfig.endpoint, traceId) : `memswe-trace://${traceId}`;
	const artifactTraceStoreRef = `memswe-trace://${traceId}`;
	return {
		enabled: true,
		traceId,
		traceStoreRef,
		startSpan: (kind, name, attributes = {}, startTimeMs = Date.now()) => {
			let ended = false;
			return {
				end: (endTimeMs = Date.now()) => {
					if (ended) return;
					ended = true;
					spans.push({
						kind,
						name,
						start_time_ms: startTimeMs - startedAtMs,
						end_time_ms: endTimeMs - startedAtMs,
						duration_ms: Math.max(0, endTimeMs - startTimeMs),
						attributes: sanitizeAttributes(attributes),
					});
				},
			};
		},
		toArtifact: () => {
			const artifactSpans = copyTraceSpans(spans);
			return {
				enabled: true,
				trace_id: traceId,
				trace_store_ref: artifactTraceStoreRef,
				spans: artifactSpans,
				completeness: traceCompletenessSummary({ enabled: true, trace_id: traceId, trace_store_ref: artifactTraceStoreRef, spans: artifactSpans }),
			};
		},
		flush: async () => {
			if (!exporterConfig) return { status: "skipped", reason: "endpoint_unset" };
			if (spans.length === 0) return { status: "skipped", reason: "empty_trace" };
			await exportOtlpTrace(exporterConfig, runId, startedAtMs, copyTraceSpans(spans));
			return { status: "exported", endpoint: exporterConfig.endpoint };
		},
	};
}

export function createMemSweTrace(runId: string, enabled: boolean): MemSweTraceRecorder {
	return enabled ? createEnabledMemSweTrace(runId) : createDisabledMemSweTrace(runId);
}

export function traceCompletenessSummary(artifact: MemSweTraceArtifact): MemSweTraceCompleteness {
	if (!artifact.enabled) {
		return { complete: false, missingKinds: [...REQUIRED_SPAN_KINDS], traceCoverage: 0 };
	}
	const presentKinds = new Set(artifact.spans.map((span) => span.kind));
	const missingKinds = REQUIRED_SPAN_KINDS.filter((kind) => !presentKinds.has(kind));
	return {
		complete: missingKinds.length === 0,
		missingKinds,
		traceCoverage: (REQUIRED_SPAN_KINDS.length - missingKinds.length) / REQUIRED_SPAN_KINDS.length,
	};
}

export function memoryLatencySummary(artifact: MemSweTraceArtifact): MemSweMemoryLatencySummary {
	if (!artifact.enabled) return { p50_ms: null, p95_ms: null };
	const durations = artifact.spans
		.filter((span) => span.kind === "memory")
		.map((span) => span.duration_ms)
		.sort((left, right) => left - right);
	if (durations.length === 0) return { p50_ms: null, p95_ms: null };
	return {
		p50_ms: durations[Math.ceil(durations.length * 0.5) - 1],
		p95_ms: durations[Math.ceil(durations.length * 0.95) - 1],
	};
}

function sanitizeTraceId(runId: string): string {
	const sanitized = runId.replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
	if (sanitized.length === 0) throw new Error("Cannot create MemSWE trace id from empty run id");
	return sanitized;
}

function sanitizeAttributes(attributes: Record<string, unknown>): Record<string, string | number | boolean | null> {
	const sanitized: Record<string, string | number | boolean | null> = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (SECRET_ATTRIBUTE_PATTERN.test(key)) continue;
		if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			sanitized[key] = value;
		}
	}
	return sanitized;
}

function copyTraceSpans(spans: MemSweTraceSpan[]): MemSweTraceSpan[] {
	return spans.map((span) => ({ ...span, attributes: { ...span.attributes } }));
}

function resolveMemSweOtlpExporterConfig(env = process.env): MemSweOtlpExporterConfig | null {
	const langfuseEndpoint = parseEndpoint(env.LANGFUSE_OTLP_ENDPOINT);
	if (langfuseEndpoint) return { endpoint: langfuseEndpoint, endpointSource: "LANGFUSE_OTLP_ENDPOINT" };
	const otelEndpoint = parseEndpoint(env.OTEL_EXPORTER_OTLP_ENDPOINT);
	if (otelEndpoint) return { endpoint: otelEndpoint, endpointSource: "OTEL_EXPORTER_OTLP_ENDPOINT" };
	return null;
}

function parseEndpoint(endpoint: string | undefined): string | null {
	if (!endpoint) return null;
	const trimmed = endpoint.trim();
	if (trimmed.length === 0) return null;
	const url = new URL(trimmed);
	if (url.pathname.endsWith("/v1/traces")) return url.toString();
	url.pathname = `${url.pathname.replace(/\/+$/u, "")}/v1/traces`;
	return url.toString();
}

async function exportOtlpTrace(
	config: MemSweOtlpExporterConfig,
	runId: string,
	startedAtMs: number,
	spans: MemSweTraceSpan[],
): Promise<void> {
	const response = await fetch(config.endpoint, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"memswe-otlp-endpoint-source": config.endpointSource,
		},
		body: JSON.stringify(toOtlpJsonTrace(runId, startedAtMs, spans)),
	});
	if (!response.ok) {
		throw new Error(`MemSWE OTLP export failed with HTTP ${response.status} ${response.statusText}`);
	}
}

function toOtlpJsonTrace(runId: string, startedAtMs: number, spans: MemSweTraceSpan[]): unknown {
	const traceId = hexDigest(runId, 32);
	return {
		resourceSpans: [
			{
				resource: {
					attributes: [
						otlpAttribute("service.name", "memswe-smoke-runner"),
						otlpAttribute("memswe.run_id", runId),
					],
				},
				scopeSpans: [
					{
						scope: { name: "memswe-trace-scaffold" },
						spans: spans.map((span, index) => ({
							traceId,
							spanId: hexDigest(`${runId}:${index}:${span.kind}:${span.name}:${span.start_time_ms}`, 16),
							name: span.name,
							kind: 1,
							startTimeUnixNano: msToUnixNano(startedAtMs + span.start_time_ms),
							endTimeUnixNano: msToUnixNano(startedAtMs + span.end_time_ms),
							attributes: [
								otlpAttribute("memswe.span_kind", span.kind),
								...Object.entries(span.attributes)
									.filter((entry): entry is [string, string | number | boolean] => entry[1] !== null)
									.map(([key, value]) => otlpAttribute(key, value)),
							],
						})),
					},
				],
			},
		],
	};
}

function otlpAttribute(key: string, value: string | number | boolean): unknown {
	if (typeof value === "boolean") return { key, value: { boolValue: value } };
	if (typeof value === "number") {
		if (Number.isSafeInteger(value)) return { key, value: { intValue: String(value) } };
		return { key, value: { doubleValue: value } };
	}
	return { key, value: { stringValue: value } };
}

function msToUnixNano(milliseconds: number): string {
	return String(Math.trunc(milliseconds * 1_000_000));
}

function hexDigest(value: string, length: number): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function otlpTraceStoreRef(endpoint: string, traceId: string): string {
	const url = new URL(endpoint);
	return `otlp://${url.host}${url.pathname}#${traceId}`;
}
