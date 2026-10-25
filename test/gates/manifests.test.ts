import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Type } from "typebox";
import { readJson, repoRoot } from "./tools.ts";

const manifest = Type.Object({
	name: Type.String(),
	dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
	devDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
	peerDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
});

/** An exact version, a workspace link, or an npm alias of an exact version. */
const pinned = /^(?:workspace:\*|(?:npm:(?:@[\w.-]+\/)?[\w.-]+@)?\d+\.\d+\.\d+(?:-[\w.]+)?)$/;

function unpinned(versions: Readonly<Record<string, string>>): readonly string[] {
	return Object.entries(versions)
		.filter(([, version]) => !pinned.test(version))
		.map(([name, version]) => `${name}@${version}`);
}

/**
 * Each peer dependency is also a dev dependency at the same version, so the package's own tests run against what
 * it asks its hosts to install. The peers that break this rule, as `name@peer version`.
 */
function peersNotTested(
	peers: Readonly<Record<string, string>>,
	dev: Readonly<Record<string, string>>,
): readonly string[] {
	return Object.entries(peers)
		.filter(([name, version]) => dev[name] !== version)
		.map(([name, version]) => `${name}@${version}`);
}

/**
 * The root manifest and that of each package folder. A file beside the folders, such as Finder's `.DS_Store`, is no
 * package.
 */
const manifestPaths = [
	"package.json",
	...["packages", "examples"].flatMap((folder) =>
		readdirSync(join(repoRoot, folder), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(folder, entry.name, "package.json")),
	),
];

test("every dependency of every package is pinned to one version", () => {
	for (const path of manifestPaths) {
		const {
			dependencies = {},
			devDependencies = {},
			peerDependencies = {},
		} = readJson(join(repoRoot, path), manifest);
		expect({ path, unpinned: unpinned({ ...dependencies, ...devDependencies, ...peerDependencies }) }).toStrictEqual({
			path,
			unpinned: [],
		});
	}
});

test("every peer dependency of every package is also its dev dependency at the same version", () => {
	for (const path of manifestPaths) {
		const { devDependencies = {}, peerDependencies = {} } = readJson(join(repoRoot, path), manifest);
		expect({ path, untested: peersNotTested(peerDependencies, devDependencies) }).toStrictEqual({
			path,
			untested: [],
		});
	}
});

test("the peer check finds a peer with no dev dependency and one at another version", () => {
	const { devDependencies = {}, peerDependencies = {} } = readJson(
		join(repoRoot, "fixtures", "manifests", "peer-not-dev.json"),
		manifest,
	);
	expect(peersNotTested(peerDependencies, devDependencies)).toStrictEqual(["chord@1.4.0", "context@1.4.0"]);
});

test("the pinned check rejects ranges and tags", () => {
	expect(
		unpinned({ a: "^1.2.3", b: "~1.2.3", c: "latest", d: "npm:typescript@^7.0.0", e: "1.2.3", f: "workspace:*" }),
	).toStrictEqual(["a@^1.2.3", "b@~1.2.3", "c@latest", "d@npm:typescript@^7.0.0"]);
});
