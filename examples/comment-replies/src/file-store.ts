import { open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { transitionId } from "@petrus/petri-net";
import type { LogEntry, NetInstanceState, NetInstanceStore } from "@petrus/runtime";
import type { Static } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { AppToken } from "./net.ts";

const Tokens = Type.Record(Type.String(), Type.Array(AppToken));

const StoredState = Type.Object({
	marking: Tokens,
	log: Type.Array(
		Type.Union([
			Type.Object({
				kind: Type.Literal("occurrence"),
				transition: Type.String(),
				binding: Type.Record(Type.String(), AppToken),
				at: Type.Number(),
			}),
			Type.Object({ kind: Type.Literal("ingress"), requestId: Type.String(), tokens: Tokens, at: Type.Number() }),
		]),
	),
});

/**
 * Keeps one net instance in one JSON file. `commit` writes a temporary file, flushes it to disk, renames it over the
 * old one and flushes the folder. A rename is atomic, so after a crash or a power loss the file holds the old state
 * or the new state, as `NetInstanceStore` requires. A file that is not there yet holds `initial`. One process at a
 * time may use the file.
 */
export function createFileStore(path: string, initial: NetInstanceState): NetInstanceStore {
	return {
		load: async () => {
			const text = await readText(path);
			return text === undefined ? initial : parseState(text);
		},
		commit: async (state) => {
			const temporary = `${path}.tmp`;
			await flushed(temporary, "w", (file) => file.writeFile(JSON.stringify(state)));
			await rename(temporary, path);
			await flushed(dirname(path), "r", () => Promise.resolve());
		},
	};
}

/** Opens `path`, runs `use`, and flushes the file to disk before it closes it. */
async function flushed(
	path: string,
	flags: "w" | "r",
	use: (file: Awaited<ReturnType<typeof open>>) => Promise<void>,
): Promise<void> {
	const file = await open(path, flags);
	try {
		await use(file);
		await file.sync();
	} finally {
		await file.close();
	}
}

async function readText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error: unknown) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

/** The file is input like any other: it is checked against the schema before the runtime sees it. */
function parseState(text: string): NetInstanceState {
	const value: unknown = JSON.parse(text);
	if (!Value.Check(StoredState, value)) {
		const problems = Value.Errors(StoredState, value).map((error) => `"${error.instancePath}" ${error.message}`);
		throw new TypeError(`stored state does not match the schema: ${problems.join("; ")}`);
	}
	return { marking: value.marking, log: value.log.map(logEntry) };
}

function logEntry(entry: Static<typeof StoredState>["log"][number]): LogEntry {
	return entry.kind === "occurrence" ? { ...entry, transition: transitionId(entry.transition) } : entry;
}
