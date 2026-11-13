import { join } from "node:path";
import { parseArgs } from "node:util";
import type { PullRef } from "./github.ts";
import { parsePullUrl } from "./github.ts";

export type Command = {
	readonly pull: PullRef;
	readonly publish: boolean;
	readonly state: string;
	readonly intervalMs: number;
};

const usage = "usage: petrus review <pull request URL> [--publish] [--state DIR] [--interval SECONDS]";

/** Reads `review <URL>` and its options. Without `--publish`, the command never writes to GitHub. */
export function parseCommand(argv: readonly string[]): Command {
	const { values, positionals } = parseArgs({
		args: [...argv],
		allowPositionals: true,
		options: {
			publish: { type: "boolean", default: false },
			state: { type: "string" },
			interval: { type: "string", default: "60" },
		},
	});
	const [verb, url, ...rest] = positionals;
	if (verb !== "review" || url === undefined || rest.length > 0) throw new Error(usage);
	const pull = parsePullUrl(url);
	return {
		pull,
		publish: values.publish,
		state: values.state ?? join(".petrus", pull.owner, pull.repo, String(pull.number)),
		intervalMs: seconds(values.interval) * 1000,
	};
}

function seconds(text: string): number {
	const value = Number(text);
	if (!Number.isInteger(value) || value < 10)
		throw new Error("--interval takes a whole number of seconds, 10 or more");
	return value;
}
