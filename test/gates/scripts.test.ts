import { join } from "node:path";
import { expect, test } from "vitest";
import { Type } from "typebox";
import { readJson, repoRoot } from "./tools.ts";

/** One command vocabulary, no aliases. A rename must change this list on purpose. */
const scriptNames = [
	"feedback",
	"format",
	"format:check",
	"inspect",
	"lint",
	"lint:api",
	"lint:dead",
	"lint:deps",
	"lint:docs",
	"lint:md",
	"periodic",
	"prepare",
	"scale",
	"test",
	"test:gates",
	"typecheck",
];

test("package.json has exactly the agreed script names", () => {
	const manifest = readJson(
		join(repoRoot, "package.json"),
		Type.Object({ scripts: Type.Record(Type.String(), Type.String()) }),
	);
	expect(Object.keys(manifest.scripts).sort()).toStrictEqual(scriptNames);
});
