// Planted defect: the marking and the log land in two commits, so a crash between them splits them.
import type { Runtime, RuntimeOptions, Stepped } from "../../packages/runtime/src/index.ts";
import { advance } from "../../packages/runtime/src/advance.ts";
import { createRuntime } from "../../packages/runtime/src/runtime.ts";
import { createSerialQueue } from "../../packages/runtime/src/serial-queue.ts";

export function createSplitCommitRuntime(options: RuntimeOptions): Runtime {
	const serial = createSerialQueue();
	const stepNow = async (): Promise<Stepped> => {
		const state = await options.store.load();
		const stepped = advance(options.net, options.policy, state, options.clock.now());
		if (stepped.state !== state) {
			await options.store.commit({ marking: stepped.state.marking, log: state.log });
			await options.store.commit(stepped.state);
		}
		return stepped;
	};
	return { ...createRuntime(options), step: () => serial(stepNow) };
}
