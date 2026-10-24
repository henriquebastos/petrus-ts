import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definitionOrder } from "@petrus/petri-net";
import { createRuntime } from "@petrus/runtime";
import { describe, expect, test } from "vitest";
import { createFileStore } from "../src/file-store.ts";
import { comments, free, net } from "../src/net.ts";

const empty = { marking: {}, log: [] };

function freshPath(): string {
	return join(mkdtempSync(join(tmpdir(), "comment-replies-")), "state.json");
}

describe("createFileStore", () => {
	test("a file that is not there yet holds the initial state", async () => {
		await expect(createFileStore(freshPath(), empty).load()).resolves.toBe(empty);
	});

	test("a new store over the same file reads what the last commit wrote", async () => {
		const path = freshPath();
		const store = createFileStore(path, empty);
		const runtime = createRuntime({ net, store, policy: definitionOrder, clock: { now: () => 3 } });
		await runtime.enqueue({ requestId: "pull-request:4001/7", tokens: { [free.id]: [{ repo: 4001, pr: 7 }] } });
		await runtime.enqueue({
			requestId: "comment:501",
			tokens: { [comments.id]: [{ repo: 4001, pr: 7, comment: 501, author: 91 }] },
		});
		const stepped = await runtime.step();
		expect(stepped.fired).toHaveLength(1);
		await expect(createFileStore(path, empty).load()).resolves.toStrictEqual(stepped.state);
	});

	test("refuses a file that does not match the schema, which a store must not hand to the runtime", async () => {
		const path = freshPath();
		writeFileSync(path, JSON.stringify({ marking: { free: [{ repo: 4001, pr: "seven" }] }, log: [] }));
		await expect(createFileStore(path, empty).load()).rejects.toThrow("stored state does not match the schema");
	});

	test("passes on a read error other than a missing file", async () => {
		const folder = mkdtempSync(join(tmpdir(), "comment-replies-"));
		await expect(createFileStore(folder, empty).load()).rejects.toThrow("EISDIR");
	});
});
