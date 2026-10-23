// Lint rules for Petrus. Each rule beyond the shared configs names the gap it closes
// (docs/decisions/0002-lint-gaps.md) or the house rule it enforces (docs/style-guide.md).
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
	],
};

export default tseslint.config(
	{ ignores: ["fixtures/**", "coverage/**", "reports/**", ".stryker-tmp/**"] },
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
			"@typescript-eslint/consistent-type-definitions": "off",
			"@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "separate-type-imports" }],
			"@typescript-eslint/consistent-type-exports": "error",
			"@typescript-eslint/no-import-type-side-effects": "error",
			"@typescript-eslint/consistent-type-assertions": [
				"error",
				{ assertionStyle: "as", objectLiteralTypeAssertions: "never" },
			],
			"@typescript-eslint/no-unsafe-type-assertion": "error",
			"@typescript-eslint/strict-boolean-expressions": [
				"error",
				{ allowString: true, allowNullableString: true, allowNumber: false, allowNullableNumber: false },
			],
			"@typescript-eslint/switch-exhaustiveness-check": [
				"error",
				{ considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
			],
			"@typescript-eslint/explicit-function-return-type": [
				"error",
				{ allowExpressions: true, allowTypedFunctionExpressions: true, allowIIFEs: true },
			],
			"@typescript-eslint/explicit-module-boundary-types": "error",
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
