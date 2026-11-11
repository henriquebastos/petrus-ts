/**
 * Compares the public API of each consumed package with its committed report in `packages/<name>/api/`.
 * The packages export `src/index.ts` and emit nothing, so `tsc` first writes declarations to a temp folder
 * and API Extractor reads them. `--update` rewrites the reports after an intended API change.
 * Run from the repository root (the gate test runs it from a sandbox copy).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Extractor, ExtractorConfig, ExtractorLogLevel } from "@microsoft/api-extractor";

const reportedPackages = ["petri-net", "runtime", "net-view", "net-layout", "runtime-view", "net-view-react"];
const update = process.argv.includes("--update");
const root = process.cwd();
const tsc = join(import.meta.dirname, "..", "node_modules", ".bin", "tsc");
const declarations = mkdtempSync(join(tmpdir(), "petrus-api-"));

function checkPackage(name: string): boolean {
	const packageFolder = join(root, "packages", name);
	const outDir = join(declarations, name);
	const tsconfig = join(packageFolder, "tsconfig.json");
	const reportFolder = join(packageFolder, "api");
	if (update) {
		mkdirSync(reportFolder, { recursive: true });
	}
	const emit = spawnSync(
		tsc,
		["-p", tsconfig, "--noEmit", "false", "--declaration", "--emitDeclarationOnly", "--outDir", outDir],
		{ stdio: "inherit" },
	);
	if (emit.status !== 0) {
		return false;
	}
	const config = ExtractorConfig.prepare({
		configObject: {
			projectFolder: packageFolder,
			newlineKind: "lf",
			mainEntryPointFilePath: join(outDir, "src", "index.d.ts"),
			compiler: { tsconfigFilePath: tsconfig },
			apiReport: { enabled: true, reportFolder, reportTempFolder: join(outDir, "report") },
			docModel: { enabled: false },
			dtsRollup: { enabled: false },
			tsdocMetadata: { enabled: false },
			messages: {
				extractorMessageReporting: {
					"ae-missing-release-tag": { logLevel: ExtractorLogLevel.None },
					// The style guide asks for a JSDoc line on each exported name; this makes it a check.
					"ae-undocumented": { logLevel: ExtractorLogLevel.Error, addToApiReportFile: false },
				},
			},
		},
		configObjectFullPath: undefined,
		packageJsonFullPath: join(packageFolder, "package.json"),
	});
	return Extractor.invoke(config, { localBuild: update }).succeeded;
}

const failed = reportedPackages.filter((name) => !checkPackage(name));
rmSync(declarations, { recursive: true, force: true });
if (failed.length > 0) {
	console.error(
		`API check failed for: ${failed.join(", ")}. If the API change is intended, run: pnpm lint:api --update`,
	);
	process.exitCode = 1;
}
