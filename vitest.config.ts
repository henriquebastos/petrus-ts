import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts"],
		restoreMocks: true,
		clearMocks: true,
		coverage: {
			provider: "istanbul",
			include: ["packages/*/src/**/*.ts"],
			reporter: ["text-summary", "json", "lcov"],
			thresholds: { statements: 90, lines: 90, functions: 90, branches: 85 },
		},
	},
});
