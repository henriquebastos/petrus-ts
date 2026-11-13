// node scripts/mutation-inputs.ts <base sha> <head sha>
// Prints "skip" when the commits from <base> to <head> change nothing that `pnpm periodic` reads, and "run" otherwise.
// The pre-push hook runs periodic unless it reads "skip", so an error, which prints nothing, still runs it.
import { execFileSync } from "node:child_process";

// Stryker mutates packages/petri-net and packages/runtime, and runs only package tests (vitest.mutation.config.ts),
// so a test of any package may kill a mutant. The root files configure Stryker, Vitest, TypeScript or dependencies.
const rootInputs =
	/^(stryker\.config\.json|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.node-version|vitest[^/]*\.config\.ts|tsconfig[^/]*\.json|test\/mutation-seed\.ts)$/;

/** True when one of `paths` can change the mutation score. */
export function mutationInputsChanged(paths: readonly string[]): boolean {
	return paths.some((path) => path.startsWith("packages/") || rootInputs.test(path));
}

if (import.meta.main) {
	const [base, head] = process.argv.slice(2);
	if (base === undefined || head === undefined)
		throw new Error("usage: node scripts/mutation-inputs.ts <base> <head>");
	const paths = execFileSync("git", ["diff", "--name-only", base, head], { encoding: "utf8" }).split("\n");
	console.log(mutationInputsChanged(paths) ? "run" : "skip");
}
