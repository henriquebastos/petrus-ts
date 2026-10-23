import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { repoRoot, runScript, sandbox } from "./tools.ts";

const script = "scripts/check-api.ts";

test("the committed API reports match the real package roots", async () => {
	const run = await runScript(script, [], repoRoot);
	expect(run.exitCode).toBe(0);
});

test("a new runtime export fails the API check until the report is updated", async () => {
	const root = sandbox({ "tsconfig.base.json": "tsconfig.base.json", packages: "packages" });
	appendFileSync(
		join(root, "packages/runtime/src/index.ts"),
		readFileSync(join(repoRoot, "fixtures/api/runtime-index-tail.ts")),
	);
	const changed = await runScript(script, [], root);
	expect(changed.exitCode).toBe(1);
	expect(changed.stderr).toContain("You have changed the API signature for this project");
	expect(changed.stderr).toContain("API check failed for: runtime.");

	const updated = await runScript(script, ["--update"], root);
	expect(updated.exitCode).toBe(0);
	expect(readFileSync(join(root, "packages/runtime/api/runtime.api.md"), "utf8")).toContain(
		"export function createSerialQueue(): SerialQueue;",
	);
	expect((await runScript(script, [], root)).exitCode).toBe(0);
});
