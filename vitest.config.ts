import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/test/**/*.test.{ts,tsx}", "examples/*/test/**/*.test.{ts,tsx}"],
		restoreMocks: true,
		clearMocks: true,
		coverage: {
			provider: "istanbul",
			include: ["packages/*/src/**/*.{ts,tsx}", "examples/*/src/**/*.ts", "examples/*/viewer/**/*.{ts,tsx}"],
			// main.ts runs in a child process in its test, where coverage is not measured.
			// A *cli.ts composition root needs the user's gh login or a model key, so only a person runs it;
			// the modules it wires are tested with typed fakes.
			// The browser entry only mounts App; the UI tests exercise App and the viewer.
			exclude: ["examples/*/src/main.ts", "examples/*/src/*cli.ts", "examples/*/viewer/main.tsx"],
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
				"examples/*/viewer/**": { statements: 90, lines: 90, functions: 90, branches: 85 },
			},
		},
	},
});
