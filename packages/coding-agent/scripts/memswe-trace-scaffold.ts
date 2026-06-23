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
};

export function createDisabledMemSweTrace(_runId: string): MemSweTraceRecorder {
	return {
		enabled: false,
		traceId: null,
		traceStoreRef: null,
		startSpan: () => ({ end: () => {} }),
		toArtifact: () => ({ enabled: false }),
	};
}

export function createEnabledMemSweTrace(runId: string, startedAtMs = Date.now()): MemSweTraceRecorder {
	const traceId = sanitizeTraceId(runId);
	const spans: MemSweTraceSpan[] = [];
	return {
		enabled: true,
		traceId,
		traceStoreRef: `memswe-trace://${traceId}`,
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
			const artifactSpans = spans.map((span) => ({ ...span, attributes: { ...span.attributes } }));
			return {
				enabled: true,
				trace_id: traceId,
				trace_store_ref: `memswe-trace://${traceId}`,
				spans: artifactSpans,
				completeness: traceCompletenessSummary({ enabled: true, trace_id: traceId, trace_store_ref: `memswe-trace://${traceId}`, spans: artifactSpans }),
			};
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
