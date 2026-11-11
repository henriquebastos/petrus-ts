import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { definitionOrder } from "@petrus/petri-net";
import type { Marking, Net } from "@petrus/petri-net";
import type { Clock, Handler } from "@petrus/runtime";
import { createRuntime, withHandlers } from "@petrus/runtime";
import { Value } from "typebox/value";
import type { Recording } from "@petrus/net-view";
import { projectNet } from "@petrus/net-view";
import { replay } from "@petrus/runtime-view";

/** Runs a classical net on Durable and checks replay against the committed state. */
export async function recordRun(
	title: string,
	base: Net,
	handlers: readonly Handler[],
	marking: Marking,
	clock: Clock,
): Promise<Recording> {
	const net = withHandlers(
		base,
		handlers.map(({ transition }) => transition),
	);
	const runtime = createRuntime({
		name: "viewer-demo",
		nonce: randomUUID(),
		net: base,
		handlers,
		policy: definitionOrder,
		clock,
		retryDelayMs: 1_000,
	});
	const registry = createRegistry();
	registry.install(runtime.extension);
	const context = BACKGROUND_CONTEXT;
	const harness = await Harness.open(
		new MemoryStorage(),
		{ models: createModels(), registry, now: clock.now },
		context,
	);
	try {
		const instance = runtime.instance(harness, (await harness.root(context)).id);
		await instance.enqueue({ requestId: "initial", tokens: marking }, context);
		await harness.waitForIdle(context);
		const state = await instance.state(context);
		const frames = replay(net, state.log);
		if (!Value.Equal(frames.at(-1)?.marking, state.marking))
			throw new Error("Replay differs from the committed marking");
		if ((await instance.inFlight(context)).length !== 0)
			throw new Error("The recording ended with unfinished operations");
		return {
			format: "petrus-recording-1",
			source: "Generated from the local Petrus TS source",
			title,
			...projectNet(net),
			frames,
			committedMarking: Object.fromEntries(Object.entries(state.marking).map(([id, tokens]) => [id, [...tokens]])),
		};
	} finally {
		await harness.close(context);
	}
}
