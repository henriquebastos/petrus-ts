import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Type } from "typebox";
import { readJson, repoRoot, sandbox } from "./tools.ts";

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
 * The root manifest and that of each package folder under `root`. A file beside the folders, such as Finder's
 * `.DS_Store`, is no package. Nor is a folder without a manifest, such as the `node_modules` that a removed package
 * leaves in an updated checkout; pnpm skips it too.
 */
function manifestPaths(root: string): readonly string[] {
	return [
		"package.json",
		...["packages", "examples"].flatMap((folder) =>
			readdirSync(join(root, folder), { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(folder, entry.name, "package.json"))
				.filter((path) => existsSync(join(root, path))),
		),
	];
}

const repoManifests = manifestPaths(repoRoot);

test("every dependency of every package is pinned to one version", () => {
	for (const path of repoManifests) {
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
	for (const path of repoManifests) {
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

test("a package folder that holds only node_modules has no manifest to check", () => {
	const root = sandbox({
		"package.json": "package.json",
		"packages/petri-net/package.json": "packages/petri-net/package.json",
		"examples/classics/package.json": "examples/classics/package.json",
	});
	mkdirSync(join(root, "packages", "net-view", "node_modules"), { recursive: true });
	expect(manifestPaths(root)).toStrictEqual([
		"package.json",
		"packages/petri-net/package.json",
		"examples/classics/package.json",
	]);
});
