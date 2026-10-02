import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createExtensionRuntime, loadExtensions, type LoadExtensionsResult } from "../src/core/extensions/index.ts";

// pi-langfuse persists interactive setup here; mirror its CONFIG_PATH so the
// harness can detect a saved configuration without importing the package.
const LANGFUSE_CONFIG_PATH = resolve(homedir(), ".pi", "agent", "pi-langfuse", "config.json");

type PiPackageManifest = {
	pi?: { extensions?: string[] };
};

/**
 * Agent-level Langfuse tracing only activates when pi-langfuse can find
 * credentials. This mirrors its loadConfig precedence: a saved config file
 * (written by `/langfuse-setup`) or the `LANGFUSE_PUBLIC_KEY` /
 * `LANGFUSE_SECRET_KEY` environment pair. Without either, loading the extension
 * is a no-op, so the deterministic faux smoke path stays unchanged.
 */
export function isLangfuseAgentTracingConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY) return true;
	return existsSync(LANGFUSE_CONFIG_PATH);
}

function emptyExtensions(): LoadExtensionsResult {
	return { extensions: [], errors: [], runtime: createExtensionRuntime() };
}

/**
 * Resolve and load the pi-langfuse extension from its installed package
 * manifest, returning the loaded extensions plus a runtime in the shape the
 * agent-session resource loader expects from `getExtensions()`.
 *
 * The package is loaded by path (not a static import) so its transitive
 * `@langfuse/*` / `@opentelemetry/*` types never enter the harness typecheck
 * and a missing optional dependency degrades to an inert run instead of
 * aborting it.
 */
export async function loadLangfuseExtensions(cwd: string): Promise<LoadExtensionsResult> {
	try {
		const require = createRequire(import.meta.url);
		const manifestPath = require.resolve("pi-langfuse/package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PiPackageManifest;
		const declared = manifest.pi?.extensions ?? ["./index.ts"];
		const packageDir = dirname(manifestPath);
		const entries = declared.map((entry) => resolve(packageDir, entry));
		const result = await loadExtensions(entries, cwd);
		for (const error of result.errors) {
			console.warn(`Langfuse: failed to load extension ${error.path}: ${error.error}`);
		}
		return result;
	} catch (error) {
		console.warn(
			`Langfuse: pi-langfuse extension unavailable: ${error instanceof Error ? error.message : String(error)}`,
		);
		return emptyExtensions();
	}
}
