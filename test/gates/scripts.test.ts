import { join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { readJson, repoRoot } from "./tools.ts";

/** One command vocabulary, no aliases. A rename must change this list on purpose. */
const scriptNames = [
	"feedback",
	"format",
	"format:check",
	"inspect",
	"lint",
	"lint:dead",
	"lint:deps",
	"lint:md",
	"periodic",
	"test",
	"test:gates",
	"typecheck",
];

test("package.json has exactly the agreed script names", () => {
	const manifest = readJson(join(repoRoot, "package.json"), z.object({ scripts: z.record(z.string(), z.string()) }));
	expect(Object.keys(manifest.scripts).sort()).toStrictEqual(scriptNames);
});
