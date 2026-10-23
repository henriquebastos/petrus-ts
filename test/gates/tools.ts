import { execFile } from "node:child_process";
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
	for (const [target, source] of Object.entries(files)) {
		cpSync(join(repoRoot, source), join(root, target), { recursive: true });
	}
	return root;
}

/** Reads a JSON file and checks its shape. Parsed input is untrusted until a schema accepts it. */
export function readJson<TSchema extends z.ZodType>(path: string, schema: TSchema): z.infer<TSchema> {
	return schema.parse(JSON.parse(readFileSync(path, "utf8")));
}
