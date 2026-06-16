import { spawn } from "node:child_process";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";

export type ShellCommandResult = {
	command: string;
	exit_code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	duration_ms: number;
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
