#!/usr/bin/env node
// petrus review <pull request URL> [--publish] [--state DIR] [--interval SECONDS]
// The composition root: the only file that reads the system clock, the process arguments, the environment and timers.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { parseCommand } from "./command.ts";
import { ghProcess, gitHub } from "./github.ts";
import { openHost, watch } from "./host.ts";
import { opusPullReviewer } from "./pull-reviewer.ts";

const context = BACKGROUND_CONTEXT;
const command = parseCommand(process.argv.slice(2));
if (!process.env.ANTHROPIC_API_KEY) throw new Error("Set ANTHROPIC_API_KEY in the environment");
const log = (line: string): void => {
	console.log(line);
};
const github = gitHub(ghProcess("gh"), command.pull);
const author = await github.login();
const models = createModels();
models.setProvider(anthropicProvider());
// eslint-disable-next-line no-restricted-properties -- the composition root makes the clock that the runtime takes
const clock = { now: () => Date.now() };
const stop = new AbortController();
const faults: string[] = [];
process.once("SIGINT", () => {
	stop.abort();
});
// With fsync a power loss leaves whole commits only; see examples/comment-replies/README.md section 4.
const storage = await openNodeJsonlStorage(command.state, context, { fsync: true });
const { harness, instance } = await openHost(
	storage,
	{ github, reviewer: opusPullReviewer(models), author, clock, log },
	{
		publishing: command.publish,
		nonce: randomUUID(),
		harness: {
			onReport: (error, info) => {
				if (info.type !== "task_faulted") return;
				faults.push(info.task.kind);
				log(`${info.task.kind} faulted: ${String(error)}`);
				stop.abort();
			},
		},
	},
	context,
);
try {
	log(`Watching ${command.pull.owner}/${command.pull.repo}#${String(command.pull.number)} as @${author}`);
	log(`${command.publish ? "Publishing reviews" : "Dry run: no GitHub writes"}; state in ${command.state}`);
	harness.resume();
	const closed = await watch(
		{
			github,
			instance,
			log,
			wait: () => sleep(command.intervalMs, undefined, { signal: stop.signal }).catch(() => undefined),
			stopped: () => stop.signal.aborted,
		},
		context,
	);
	if (closed) {
		log("The pull request is closed; finishing work in flight");
		await harness.waitForIdle(context);
	}
	for (const operation of await instance.inFlight(context)) log(`Unfinished: ${operation.id}`);
} finally {
	await harness.close(context);
}
process.exitCode = faults.length === 0 ? 0 : 1;
