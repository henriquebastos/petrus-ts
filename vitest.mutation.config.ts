import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

/**
 * Stryker runs the unit tests with this config, inside its sandbox copy of the repository.
 * The sandbox links each package's node_modules back to the real repository, so `@petrus/net`
 * would load the unmutated source. The alias points it at the sandbox copy, so runtime tests see net mutants.
 */
export default mergeConfig(
	base,
	defineConfig({
		resolve: { alias: { "@petrus/net": fileURLToPath(new URL("packages/net/src/index.ts", import.meta.url)) } },
		test: { setupFiles: ["test/mutation-seed.ts"] },
	}),
);
