import type { Clock } from "@petrus/runtime";
import type { Recording } from "@petrus/net-view";
import { diningPhilosophers, diningPhilosophersHandlers, initialMarking } from "./dining-philosophers.ts";
import { recordRun } from "./record-run.ts";

/** Records five philosophers, with one meal for each philosopher. */
export function recordDiningPhilosophers(clock: Clock): Promise<Recording> {
	return recordRun(
		"Dining philosophers",
		diningPhilosophers,
		diningPhilosophersHandlers(5, { eat: () => Promise.resolve() }),
		initialMarking(5, ["p0", "p1", "p2", "p3", "p4"]),
		clock,
	);
}
