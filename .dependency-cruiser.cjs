/**
 * The ordering blocks upward imports. The display rules also block execution and layout across sibling branches.
 * A package imports another through its root. A host may also load the public viewer stylesheet.
 * Type-only edges count for cycles.
 */
const layers = [
	"petri-net",
	"runtime",
	"net-view-model",
	"net-layout",
	"runtime-replay",
	"net-viewer-react",
	"hamsterdan",
	"hamsterdan-github",
	"hamsterdan-cli",
];

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
			name: "display-does-not-run-or-layout",
			severity: "error",
			comment: "The React display consumes data. Runtime replay and layout remain host choices.",
			from: { path: "^packages/net-viewer-react/" },
			to: { path: "^packages/(runtime|runtime-replay|net-layout)/" },
		},
		{
			name: "view-data-does-not-run",
			severity: "error",
			from: { path: "^packages/(net-view-model|net-layout)/" },
			to: { path: "^packages/runtime/" },
		},
		{
			name: "cross-package-via-root-only",
			severity: "error",
			comment: "Another package's files are private: import @petrus/x, not its src files.",
			from: { path: "^packages/([^/]+)/" },
			to: { path: "^packages/([^/]+)/src/", pathNot: ["^packages/$1/", "^packages/[^/]+/src/index\\.ts$"] },
		},
		{
			name: "examples-use-package-roots",
			severity: "error",
			comment: "An example is a host app: it imports @petrus/x like any app, never another file of a package.",
			from: { path: "^examples/" },
			to: {
				path: "^packages/",
				pathNot: ["^packages/[^/]+/src/index\\.ts$", "^packages/net-viewer-react/src/style\\.css$"],
			},
		},
		{
			name: "packages-never-import-examples",
			severity: "error",
			from: { path: "^packages/" },
			to: { path: "^examples/" },
		},
		{
			name: "petri-net-is-pure",
			severity: "error",
			comment: "petri-net imports no Node builtin and no npm package: it runs anywhere and needs no clock or disk.",
			from: { path: "^packages/petri-net/src/" },
			to: { dependencyTypes: ["core", "npm", "npm-dev", "npm-optional", "npm-peer", "npm-no-pkg", "npm-unknown"] },
		},
		{
			name: "src-never-imports-tests",
			severity: "error",
			from: { path: "^(packages|examples)/[^/]+/src/" },
			to: { path: "^(packages|examples)/[^/]+/test/" },
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
		// Without this, an `import type` edge is invisible and a type-only cycle passes.
		tsPreCompilationDeps: true,
		tsConfig: { fileName: `${__dirname}/tsconfig.base.json` },
		enhancedResolveOptions: {
			// Resolve `@petrus/x` through its package.json `exports`; without this an upward import by name is not seen.
			exportsFields: ["exports"],
			conditionNames: ["import", "types", "default"],
		},
	},
};
