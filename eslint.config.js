// Lint rules for Petrus: typescript-eslint strictTypeChecked and stylisticTypeChecked, plus the rules below.
// Each added rule closes a bug that the shared configs let pass; its comment or message says which.
// The first line of each file in fixtures/lint/ names the rules that its planted defect must trigger.
// Off on purpose: no-await-in-loop, because steps must run in order.
import js from "@eslint/js";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import tseslint from "typescript-eslint";

const houseSyntax = [
	{ selector: "ExportDefaultDeclaration", message: "Use a named export (Pocock: default-exports)." },
	{ selector: "ExportAllDeclaration", message: "Re-export names one by one, so dead exports stay visible." },
	{
		selector: "ImportDeclaration[importKind='value'] > ImportSpecifier[importKind='type']",
		message: "Use a top-level `import type { ... }` line (Pocock: import-type).",
	},
	{
		selector: "TSInterfaceDeclaration[extends.length=0]",
		message: "Use `type` by default. An interface is only for `extends` (Pocock: interface-extends).",
	},
];

const ambientWorld = {
	"no-restricted-properties": [
		"error",
		{ object: "Date", property: "now", message: "Take time from the injected Clock." },
		{ object: "Math", property: "random", message: "Take randomness from an injected seeded source." },
		{ object: "performance", property: "now", message: "Take time from the injected Clock." },
	],
	"no-restricted-globals": [
		"error",
		{ name: "setTimeout", message: "Take timers from an injected seam." },
		{ name: "setInterval", message: "Take timers from an injected seam." },
		{ name: "setImmediate", message: "Take timers from an injected seam." },
	],
	"no-restricted-syntax": [
		"error",
		...houseSyntax,
		{ selector: "NewExpression[callee.name='Date']", message: "Take time from the injected Clock." },
		{ selector: "CallExpression[callee.name='Date']", message: "Take time from the injected Clock." },
		{
			selector:
				"MemberExpression[object.name='globalThis'][property.name=/^(Date|Math|performance|setTimeout|setInterval|setImmediate)$/]",
			message: "Take time, randomness and timers from injected seams.",
		},
	],
};

export default tseslint.config(
	{ ignores: ["fixtures/**", "coverage/**", "reports/**", ".stryker-tmp/**"] },
	// no-empty and preserve-caught-error: an empty catch, or a wrapped error without its cause, hides a failure.
	js.configs.recommended,
	comments.recommended,
	...tseslint.configs.strictTypeChecked,
	...tseslint.configs.stylisticTypeChecked,
	{
		languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
		linterOptions: { reportUnusedDisableDirectives: "error" },
		rules: {
			complexity: ["error", 10],
			"max-depth": ["error", 4],
			"no-restricted-syntax": ["error", ...houseSyntax],
			"no-restricted-imports": [
				"error",
				{ patterns: [{ regex: "^\\.{1,2}/.*\\.js$", message: "Import the `.ts` file; Node runs the source." }] },
			],
			"@eslint-community/eslint-comments/require-description": ["error", { ignore: [] }],
			// `type` by default. This rule would also flag `interface X extends Y`; the syntax rule above bans only a bare interface.
			"@typescript-eslint/consistent-type-definitions": "off",
			"@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "separate-type-imports" }],
			"@typescript-eslint/consistent-type-exports": "error",
			// `import { type X }` still loads the module at run time; `import type` does not.
			"@typescript-eslint/no-import-type-side-effects": "error",
			// `{ ... } as T` hides a missing field. Annotate the literal or use `satisfies`.
			"@typescript-eslint/consistent-type-assertions": [
				"error",
				{ assertionStyle: "as", objectLiteralTypeAssertions: "never" },
			],
			// `JSON.parse(body) as T` and `as unknown as T` lie to the checker. Parse untrusted input with a TypeBox schema (`parseJson` in scripts/json.ts).
			// A brand constructor is the one accepted exception, with a reasoned suppression.
			"@typescript-eslint/no-unsafe-type-assertion": "error",
			// `if (timeoutMs)` is false for 0, so numbers must be compared. Strings and nullable objects may be tested for truth.
			"@typescript-eslint/strict-boolean-expressions": [
				"error",
				{ allowString: true, allowNullableString: true, allowNumber: false, allowNullableNumber: false },
			],
			// A switch over a union must handle every case. In a default that must never run, write `value satisfies never`.
			"@typescript-eslint/switch-exhaustiveness-check": [
				"error",
				{ considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
			],
			"@typescript-eslint/explicit-function-return-type": [
				"error",
				{ allowExpressions: true, allowTypedFunctionExpressions: true, allowIIFEs: true },
			],
			"@typescript-eslint/explicit-module-boundary-types": "error",
			// tsc accepts `_name` for an unused binding; the linter agrees.
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
			],
		},
	},
	{ files: ["**/packages/*/src/**/*.ts"], rules: ambientWorld },
	{
		// Pocock's default-exports rule allows a default export where a tool requires one.
		files: ["*.config.ts", "*.config.js"],
		rules: { "no-restricted-syntax": ["error", ...houseSyntax.slice(1)] },
	},
	{ files: ["**/*.js", "**/*.cjs", "**/*.mjs"], ...tseslint.configs.disableTypeChecked },
	{
		files: ["**/*.cjs"],
		languageOptions: {
			sourceType: "commonjs",
			globals: { module: "writable", require: "readonly", __dirname: "readonly" },
		},
	},
);
