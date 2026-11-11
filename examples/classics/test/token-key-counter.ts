import { Session } from "node:inspector";

/** V8 counts calls without changing primitive tokens or replacing the pure tokenKey function. */
export function countTokenKeys(): { readonly take: () => number; readonly close: () => void } {
	const session = new Session();
	session.connect();
	session.post("Profiler.enable");
	session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: false });
	return {
		take: () => {
			let count: number | undefined;
			session.post("Profiler.takePreciseCoverage", (error, coverage) => {
				if (error !== null) throw error;
				count = coverage.result
					.filter((script) => script.url.endsWith("/packages/petri-net/src/token.ts"))
					.flatMap((script) => script.functions)
					.filter((fn) => fn.functionName === "tokenKey")
					.reduce((sum, fn) => sum + (fn.ranges[0]?.count ?? 0), 0);
			});
			if (count === undefined) throw new Error("the local inspector did not return its synchronous call counts");
			return count;
		},
		close: () => {
			session.post("Profiler.stopPreciseCoverage");
			session.disconnect();
		},
	};
}
