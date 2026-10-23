import { execFile, execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";

export const repoRoot = join(import.meta.dirname, "..", "..");

export type ToolRun = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

/** Runs a tool from the repository's node_modules and returns its exit code and output. It never throws on exit code. */
export function runTool(tool: string, args: readonly string[], cwd: string): Promise<ToolRun> {
	return new Promise((resolve) => {
		execFile(
			join(repoRoot, "node_modules", ".bin", tool),
			args,
			{ cwd, maxBuffer: 32 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
				resolve({ exitCode, stdout, stderr });
			},
		);
	});
}

/** The rule names listed on a fixture's first line: `// expect: a b c`. */
export function expectedRules(path: string): ReadonlySet<string> {
	const firstLine = readFileSync(path, "utf8").split("\n")[0] ?? "";
	const listed = firstLine.replace(/^\/\/ expect:/, "").trim();
	return new Set(listed === "" ? [] : listed.split(/\s+/));
}

/**
 * Copies real repository files and fixture files into a new temporary folder, so a tool that skips
 * `fixtures/` sees the planted defect at a path its real config covers. `files` maps target path to source path.
 */
export function sandbox(files: Readonly<Record<string, string>>): string {
	const root = mkdtempSync(join(tmpdir(), "petrus-gate-"));
	symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"));
	plant(root, files);
	return root;
}

/** Copies repository files into an existing sandbox. `files` maps target path to source path. */
export function plant(root: string, files: Readonly<Record<string, string>>): void {
	for (const [target, source] of Object.entries(files)) {
		cpSync(join(repoRoot, source), join(root, target), { recursive: true });
	}
}

/**
 * Makes the sandbox a git repository on `main` with one commit of its current files, so a tool that
 * compares changes with a base (`fallow audit`) sees later planted files as the change. User hooks and signing are off.
 */
export function commitBaseline(root: string): void {
	const git = (...args: readonly string[]): void => {
		execFileSync("git", args, { cwd: root, stdio: "ignore" });
	};
	git("init", "--quiet", "--initial-branch=main");
	git("add", "--all");
	git(
		"-c",
		"user.name=gate",
		"-c",
		"user.email=gate@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"-c",
		"core.hooksPath=/dev/null",
		"commit",
		"--quiet",
		"--no-verify",
		"--message=baseline",
	);
}

/** Reads a JSON file and checks its shape. Parsed input is untrusted until a schema accepts it. */
export function readJson<TSchema extends z.ZodType>(path: string, schema: TSchema): z.infer<TSchema> {
	return schema.parse(JSON.parse(readFileSync(path, "utf8")));
}
