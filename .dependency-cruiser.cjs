/**
 * Package layers, lowest first: net <- runtime <- hamsterdan <- hamsterdan-github <- hamsterdan-cli.
 * A package imports only packages below it, and only through their root (`src/index.ts`).
 * Type-only edges count for cycles. Decision: docs/decisions/0001-toolchain.md.
 */
const layers = ["net", "runtime", "hamsterdan", "hamsterdan-github", "hamsterdan-cli"];

const layerRules = layers.slice(0, -1).map((layer, index) => ({
	name: `${layer}-imports-only-lower-layers`,
	severity: "error",
	comment: `${layer} must not import a package above it.`,
	from: { path: `^packages/${layer}/` },
	to: { path: `^packages/(${layers.slice(index + 1).join("|")})/` },
}));

module.exports = {
	forbidden: [
		{
			name: "no-circular",
			severity: "error",
			comment: "Imports form a tree. Type-only edges count.",
			from: {},
			to: { circular: true },
		},
		...layerRules,
		{
			name: "cross-package-via-root-only",
			severity: "error",
			comment: "Another package's files are private: import @petrus/x, not its src files.",
			from: { path: "^packages/([^/]+)/" },
			to: { path: "^packages/([^/]+)/src/", pathNot: ["^packages/$1/", "^packages/[^/]+/src/index\\.ts$"] },
		},
		{
			name: "net-is-pure",
			severity: "error",
			comment: "net imports no Node builtin and no npm package: it runs anywhere and needs no clock or disk.",
			from: { path: "^packages/net/src/" },
			to: { dependencyTypes: ["core", "npm", "npm-dev", "npm-optional", "npm-peer", "npm-no-pkg", "npm-unknown"] },
		},
		{
			name: "src-never-imports-tests",
			severity: "error",
			from: { path: "^packages/[^/]+/src/" },
			to: { path: "^packages/[^/]+/test/" },
		},
		{
			name: "not-to-unresolvable",
			severity: "error",
			from: {},
			to: { couldNotResolve: true },
		},
	],
	options: {
		doNotFollow: { path: "node_modules" },
		tsPreCompilationDeps: true,
		tsConfig: { fileName: `${__dirname}/tsconfig.base.json` },
		enhancedResolveOptions: {
			exportsFields: ["exports"],
			conditionNames: ["import", "types", "default"],
		},
	},
};
