import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Type } from "typebox";
import { readJson, repoRoot } from "./tools.ts";

const manifest = Type.Object({
	name: Type.String(),
	dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
	devDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
});

/** An exact version, a workspace link, or an npm alias of an exact version. */
const pinned = /^(?:workspace:\*|(?:npm:(?:@[\w.-]+\/)?[\w.-]+@)?\d+\.\d+\.\d+(?:-[\w.]+)?)$/;

function unpinned(versions: Readonly<Record<string, string>>): readonly string[] {
	return Object.entries(versions)
		.filter(([, version]) => !pinned.test(version))
		.map(([name, version]) => `${name}@${version}`);
}

const manifestPaths = [
	"package.json",
	...readdirSync(join(repoRoot, "packages")).map((name) => join("packages", name, "package.json")),
];

test("every dependency of every package is pinned to one version", () => {
	for (const path of manifestPaths) {
		const { dependencies = {}, devDependencies = {} } = readJson(join(repoRoot, path), manifest);
		expect({ path, unpinned: unpinned({ ...dependencies, ...devDependencies }) }).toStrictEqual({
			path,
			unpinned: [],
		});
	}
});

test("the pinned check rejects ranges and tags", () => {
	expect(
		unpinned({ a: "^1.2.3", b: "~1.2.3", c: "latest", d: "npm:typescript@^7.0.0", e: "1.2.3", f: "workspace:*" }),
	).toStrictEqual(["a@^1.2.3", "b@~1.2.3", "c@latest", "d@npm:typescript@^7.0.0"]);
});
