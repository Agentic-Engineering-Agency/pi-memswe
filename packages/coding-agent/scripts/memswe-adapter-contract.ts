export type MemoryOperation = "write" | "retrieve" | "update" | "delete";

export type AdapterScope = {
	id: string;
	providerId?: string;
	metadata?: Record<string, unknown>;
};

export type AdapterSeedEvent = {
	scope: AdapterScope;
	operation: MemoryOperation;
	content: string;
	providerId?: string;
	metadata?: Record<string, unknown>;
};

export type AdapterRunInput = {
	scope: AdapterScope;
	prompt: string;
	providerId?: string;
	metadata?: Record<string, unknown>;
};

export type AdapterRunResult = {
	output: string;
	trace: NormalizedTrace;
	artifacts?: NormalizedArtifact[];
};

export type NormalizedTrace = {
	providerId: string;
	scopeId: string;
	events: NormalizedTraceEvent[];
	latencyMs: number;
	injectedMemoryTokens: number;
	errors: NormalizedTraceError[];
	artifacts: NormalizedArtifact[];
};

export type NormalizedTraceEvent = {
	operation: MemoryOperation;
	providerId: string;
	scopeId: string;
	latencyMs?: number;
	injectedMemoryTokens?: number;
	memoryId?: string;
	input?: string;
	output?: string;
	metadata?: Record<string, unknown>;
};

export type NormalizedTraceError = {
	message: string;
	providerId?: string;
	operation?: MemoryOperation;
	code?: string;
	artifactId?: string;
};

export type NormalizedArtifact = {
	id: string;
	kind: string;
	path?: string;
	contentType?: string;
	metadata?: Record<string, unknown>;
};

export type AdapterExport = {
	providerId: string;
	scopeId?: string;
	traces: NormalizedTrace[];
	artifacts: NormalizedArtifact[];
};

export interface AmsAdapter {
	reset(scope: AdapterScope): Promise<NormalizedTrace>;
	seed(events: AdapterSeedEvent[]): Promise<NormalizedTrace>;
	run(input: AdapterRunInput): Promise<AdapterRunResult>;
	observe(): Promise<NormalizedTrace>;
	delete(scope: AdapterScope): Promise<NormalizedTrace>;
	export(): Promise<AdapterExport>;
}
