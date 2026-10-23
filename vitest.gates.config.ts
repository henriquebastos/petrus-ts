import { defineConfig } from "vitest/config";

/** The gate tests run each quality tool on a planted defect and check that it still fails. */
export default defineConfig({
	test: {
		include: ["test/gates/**/*.test.ts"],
		testTimeout: 120_000,
		hookTimeout: 120_000,
	},
});
