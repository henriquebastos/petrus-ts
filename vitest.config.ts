import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
		restoreMocks: true,
		clearMocks: true,
		coverage: {
			provider: "istanbul",
			include: ["packages/*/src/**/*.ts", "examples/*/src/**/*.ts"],
			// main.ts runs in a child process in its test, where coverage is not measured.
			exclude: ["examples/*/src/main.ts"],
			reporter: ["text-summary", "json", "lcov"],
			// The global figure keeps the planted-defect gate simple; each glob holds its own files to the same bar,
			// so well-covered example code cannot hide a package below it.
			thresholds: {
				statements: 90,
				lines: 90,
				functions: 90,
				branches: 85,
				"packages/*/src/**": { statements: 90, lines: 90, functions: 90, branches: 85 },
				"examples/*/src/**": { statements: 90, lines: 90, functions: 90, branches: 85 },
			},
		},
	},
});
