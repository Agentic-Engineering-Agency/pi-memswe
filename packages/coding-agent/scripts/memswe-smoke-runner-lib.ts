import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type VerifierKind = "visible" | "hidden" | "protected";

export type TaskYaml = {
	memswe?: {
		verifiers?: {
			visible_tests?: VerifierSpec[];
			hidden_tests?: VerifierSpec[];
			protected_tests?: VerifierSpec[];
		};
	};
};

type VerifierSpec = {
	command?: string;
	agent_visible?: boolean;
};

export type VerifierAsset = {
	kind: VerifierKind;
	source: string;
	destination: string;
	agentVisible: boolean;
};

export type ShellCommandResult = {
	command: string;
	exit_code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	duration_ms: number;
};

export type PatchArtifacts = {
	agentPatch: string;
	worktreeDiff: string;
	changedFiles: string;
};

export async function runShellCommand(
	command: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
): Promise<ShellCommandResult> {
	const start = Date.now();
	return new Promise((resolveCommand) => {
		const child = spawn(command, {
			cwd,
			env,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolveCommand({
				command,
				exit_code: timedOut ? null : code,
				signal,
				stdout,
				stderr: timedOut ? `${stderr}\nTimed out after ${timeoutMs}ms` : stderr,
				duration_ms: Date.now() - start,
			});
		});
	});
}

export async function preparePythonEnvironment(
	workdir: string,
	setupCommand: string | undefined,
): Promise<{ shimDir: string; setupResult?: ShellCommandResult }> {
	const shimDir = join(workdir, ".memswe-bin");
	const venvDir = join(workdir, ".memswe-venv");
	const venvBinDir = join(venvDir, "bin");
	await mkdir(shimDir, { recursive: true });
	const createVenvResult = await runShellCommand("python3 -m venv .memswe-venv", workdir, process.env, 120_000);
	if (createVenvResult.exit_code !== 0) {
		throw new Error(`Failed to create verifier virtualenv: ${createVenvResult.stderr || createVenvResult.stdout}`);
	}
	await symlink(join(venvBinDir, "python"), join(shimDir, "python")).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	await symlink(join(venvBinDir, "pip"), join(shimDir, "pip")).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	const setupEnv = { ...process.env, PATH: `${venvBinDir}:${process.env.PATH ?? ""}` };
	const setupResult = setupCommand ? await runShellCommand(setupCommand, workdir, setupEnv, 300_000) : undefined;
	if (setupResult && setupResult.exit_code !== 0) {
		throw new Error(`Verifier setup failed: ${setupResult.stderr || setupResult.stdout}`);
	}
	return { shimDir: venvBinDir, setupResult };
}

export function inferVerifierAssets(taskDir: string, workdir: string, task: TaskYaml, includeHidden: boolean): VerifierAsset[] {
	const verifiers = task.memswe?.verifiers;
	const groups: Array<[VerifierKind, VerifierSpec[] | undefined]> = [
		["visible", verifiers?.visible_tests],
		["protected", verifiers?.protected_tests],
	];
	if (includeHidden) groups.push(["hidden", verifiers?.hidden_tests]);

	const assets = new Map<string, VerifierAsset>();
	for (const [kind, specs] of groups) {
		for (const spec of specs ?? []) {
			for (const verifierPath of verifierPathsFromCommand(spec.command ?? "")) {
				assets.set(`${kind}:${verifierPath}`, {
					kind,
					source: join(taskDir, verifierPath),
					destination: join(workdir, verifierPath),
					agentVisible: kind === "visible" && spec.agent_visible === true,
				});
			}
		}
	}

	const needsPytestSupport = [...assets.values()].some((asset) => asset.source.endsWith(".py"));
	const conftestPath = "tests/conftest.py";
	if (needsPytestSupport && existsSync(join(taskDir, conftestPath))) {
		assets.set(`protected-support:${conftestPath}`, {
			kind: "protected",
			source: join(taskDir, conftestPath),
			destination: join(workdir, conftestPath),
			agentVisible: false,
		});
	}

	return [...assets.values()];
}

function verifierPathsFromCommand(command: string): string[] {
	return [...command.matchAll(/(?:^|\s)(tests\/[A-Za-z0-9_./-]+\.(?:py|ts|tsx|js|jsx))(?:\:\:[^\s]+)?/g)].map(
		(match) => match[1],
	);
}

export async function initializeWorktreeBaseline(workdir: string): Promise<void> {
	const commands = [
		"git init",
		"git add .",
		"git -c user.name=MemSWE -c user.email=memswe@example.invalid commit -m baseline --no-gpg-sign",
	];
	for (const command of commands) {
		const result = await runShellCommand(command, workdir, process.env, 120_000);
		if (result.exit_code !== 0) {
			throw new Error(`Failed to initialize temp worktree baseline with ${command}: ${result.stderr || result.stdout}`);
		}
	}
}

export async function writePatchArtifacts(workdir: string, artifactsDir: string): Promise<PatchArtifacts> {
	const worktreeDiffPath = join(artifactsDir, "worktree-diff.patch");
	const agentPatchPath = join(artifactsDir, "agent.patch");
	const changedFilesPath = join(artifactsDir, "changed-files.json");
	const diff = await runShellCommand("git diff --binary", workdir, process.env, 120_000);
	if (diff.exit_code !== 0) {
		throw new Error(`Failed to collect worktree diff: ${diff.stderr || diff.stdout}`);
	}
	const tracked = await runShellCommand("git diff --name-only", workdir, process.env, 120_000);
	if (tracked.exit_code !== 0) {
		throw new Error(`Failed to collect changed tracked files: ${tracked.stderr || tracked.stdout}`);
	}
	const untracked = await runShellCommand("git ls-files --others --exclude-standard", workdir, process.env, 120_000);
	if (untracked.exit_code !== 0) {
		throw new Error(`Failed to collect untracked files: ${untracked.stderr || untracked.stdout}`);
	}
	const changedFiles = [...new Set([...tracked.stdout.split("\n"), ...untracked.stdout.split("\n")].filter(Boolean))].sort();
	await writeFile(worktreeDiffPath, diff.stdout);
	await writeFile(agentPatchPath, diff.stdout);
	await writeFile(changedFilesPath, `${JSON.stringify(changedFiles, null, "	")}\n`);
	return { agentPatch: agentPatchPath, worktreeDiff: worktreeDiffPath, changedFiles: changedFilesPath };
}
