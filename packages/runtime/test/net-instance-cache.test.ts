import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import fc from "fast-check";
import type { Marking } from "@petrus/petri-net";
import { addTokens, definitionOrder, fireStep, indexMarking, placeId } from "@petrus/petri-net";
import { expect, onTestFinished, test } from "vitest";
import { admit } from "../src/admit.ts";
import { createNetInstanceCache } from "../src/net-instance-cache.ts";
import type { NetInstanceParts } from "../src/net-instance-commit.ts";
import { commitToRecord } from "../src/net-instance-commit.ts";
import { netInstanceRecord, readNetInstance } from "../src/net-instance-record.ts";
import type { NetInstanceHost, NetInstanceState, Occurrence } from "../src/index.ts";
import { createRuntime } from "../src/index.ts";
import { context, createClock, createDisk } from "./disk.ts";
import { contested, contestedOptions, left, ready, right } from "./properties.ts";

const conversation = ROOT_CONVERSATION_ID;

function parts(capacity: number): NetInstanceParts {
	return {
		name: "contested",
		net: contested,
		policy: definitionOrder,
		handlerIds: new Set(),
		start: () => Promise.reject(new Error("the plain net starts no operations")),
		cache: createNetInstanceCache("cache-test", capacity),
	};
}

function quiet(marking: Marking, at: number): { readonly marking: Marking; readonly fired: readonly Occurrence[] } {
	let current = marking;
	const fired: Occurrence[] = [];
	for (;;) {
		const step = fireStep(contested, current, definitionOrder);
		if (step.fired.length === 0) return { marking: current, fired };
		fired.push(...step.fired.map((element) => ({ kind: "occurrence" as const, ...element, at })));
		current = step.marking;
	}
}

test("cached and rebuilt commits preserve the oracle's state and JSON key order", () => {
	fc.assert(
		fc.property(
			fc.array(
				fc.tuple(
					fc.constantFrom(ready.id, left.id, right.id),
					fc.array(fc.constantFrom("j1", "j2"), { minLength: 1, maxLength: 4 }),
				),
				{ minLength: 1, maxLength: 30 },
			),
			(batches) => {
				const hot = parts(32);
				const cold = parts(0);
				const cached = netInstanceRecord.definition.initial();
				const rebuilt = netInstanceRecord.definition.initial();
				let expected: NetInstanceState = { marking: {}, log: [] };
				for (const [at, [place, tokens]] of batches.entries()) {
					const batch = { requestId: String(at), tokens: { [place]: tokens } };
					const change = (view: Parameters<typeof admit>[1]): ReturnType<typeof admit> =>
						admit(contested, view, batch, at);
					commitToRecord(hot, cached, change, at, conversation);
					commitToRecord(cold, rebuilt, change, at, conversation);
					const step = quiet(addTokens(expected.marking, placeId(place), tokens), at);
					expected = {
						marking: step.marking,
						log: [...expected.log, { kind: "ingress", ...batch, at }, ...step.fired],
					};
					expect(JSON.stringify(cached)).toBe(JSON.stringify(rebuilt));
					expect(JSON.stringify(readNetInstance(cached))).toBe(JSON.stringify(expected));
					const before = JSON.stringify(cached);
					commitToRecord(hot, cached, change, at + 1, conversation);
					expect(JSON.stringify(cached)).toBe(before);
				}
			},
		),
	);
});

test("a transaction aborted after the journal write cannot reuse the uncommitted index", async () => {
	const clock = createClock();
	const runtime = createRuntime(contestedOptions(definitionOrder, clock));
	const disk = createDisk([runtime.extension], clock);
	const { harness } = await disk.open();
	onTestFinished(() => harness.close(context));
	const root = await harness.root(context);
	let abort = true;
	const host: NetInstanceHost = {
		snapshot: harness.snapshot.bind(harness),
		abortTask: harness.abortTask.bind(harness),
		commit: (change, callContext) =>
			harness.commit(async (tx) => {
				const result = await change(tx);
				if (abort) {
					abort = false;
					throw new Error("abort after write");
				}
				return result;
			}, callContext),
	};
	const instance = runtime.instance(host, root.id);
	const batch = { requestId: "batch", tokens: { [ready.id]: ["j1"] } };
	await expect(instance.enqueue(batch, context)).rejects.toThrow("abort after write");
	expect(await instance.state(context)).toStrictEqual({ marking: {}, log: [] });
	await instance.enqueue(batch, context);
	const state = await instance.state(context);
	expect(state.marking).toStrictEqual({ [left.id]: ["j1"] });
	expect(state.log).toHaveLength(2);
	expect(disk.history()).toHaveLength(1);
});

test("matching stamps avoid marking reads for new and repeated batches", () => {
	const runtime = parts(8);
	const stored = netInstanceRecord.definition.initial();
	const first = { requestId: "first", tokens: { [ready.id]: ["j1"] } };
	commitToRecord(runtime, stored, (view) => admit(contested, view, first, 0), 0, conversation);
	let reads = 0;
	stored.marking = new Proxy(stored.marking, {
		ownKeys: (target) => {
			reads += 1;
			return Reflect.ownKeys(target);
		},
	});
	commitToRecord(runtime, stored, (view) => admit(contested, view, first, 1), 1, conversation);
	const next = { requestId: "next", tokens: { [ready.id]: ["j2"] } };
	commitToRecord(runtime, stored, (view) => admit(contested, view, next, 2), 2, conversation);
	expect(reads).toBe(0);
	expect(readNetInstance(stored).marking).toStrictEqual({ [left.id]: ["j1", "j2"] });
});

test("a foreign writer's stamp rebuilds the index even when the log length is unchanged", () => {
	const runtime = parts(8);
	const foreign = { ...parts(8), cache: createNetInstanceCache("foreign") };
	const stored = netInstanceRecord.definition.initial();
	const replacement = netInstanceRecord.definition.initial();
	const first = { requestId: "first", tokens: { [ready.id]: ["j1"] } };
	const second = { requestId: "second", tokens: { [ready.id]: ["j2"] } };
	const deferred = { ...runtime, policy: () => [] };
	commitToRecord(deferred, stored, (view) => admit(contested, view, first, 0), 0, conversation);
	commitToRecord(
		{ ...foreign, policy: () => [] },
		replacement,
		(view) => admit(contested, view, second, 0),
		0,
		conversation,
	);
	expect(stored.log.length).toBe(replacement.log.length);
	expect(stored.stamp).not.toBe(replacement.stamp);
	const next = { requestId: "next", tokens: { [ready.id]: ["j2"] } };
	commitToRecord(runtime, replacement, (view) => admit(contested, view, next, 1), 1, conversation);
	expect(readNetInstance(replacement).marking).toStrictEqual({ [left.id]: ["j2"], [right.id]: ["j2"] });
});

test("an empty stamp never reuses another instance's cached marking", () => {
	const runtime = parts(32);
	runtime.cache.put(conversation, { stamp: "", indexed: indexMarking(contested, { [ready.id]: ["j1"] }) });
	const fresh = netInstanceRecord.definition.initial();
	commitToRecord(
		runtime,
		fresh,
		(view) => admit(contested, view, { requestId: "new", tokens: { [ready.id]: ["j2"] } }, 2),
		2,
		conversation,
	);
	expect(readNetInstance(fresh).marking).toStrictEqual({ [left.id]: ["j2"] });
});

test("the cache evicts the least recently used instance and transfers ownership on take", async () => {
	const cache = createNetInstanceCache("one", 2);
	const { harness } = await createDisk([]).open();
	onTestFinished(() => harness.close(context));
	const a = (await harness.root(context)).id;
	const b = (await harness.createConversation({ ownership: { kind: "ownerless" } }, context)).id;
	const c = (await harness.createConversation({ ownership: { kind: "ownerless" } }, context)).id;
	const entry = { stamp: "stored", indexed: indexMarking(contested, {}) };
	cache.put(a, entry);
	cache.put(b, entry);
	expect(cache.take(a)).toBe(entry);
	expect(cache.take(a)).toBeUndefined();
	cache.put(a, entry);
	cache.put(c, entry);
	expect(cache.take(b)).toBeUndefined();
	expect(cache.take(a)).toBe(entry);
	expect(cache.take(c)).toBe(entry);
	const stamps = [cache.nextStamp(), cache.nextStamp(), createNetInstanceCache("two").nextStamp()];
	expect(new Set(stamps).size).toBe(3);
	expect(stamps[0]?.length).toBe(stamps[1]?.length);
});

test("stamps keep a fixed-width hexadecimal counter across digit boundaries", () => {
	const cache = createNetInstanceCache("nonce");
	const stamps = Array.from({ length: 32 }, () => cache.nextStamp());
	expect(new Set(stamps).size).toBe(stamps.length);
	for (const stamp of stamps) expect(stamp).toMatch(/^nonce-[0-9a-f]{16}$/);
});

test("the default cache retains eight instances and putting an existing entry refreshes its recency", async () => {
	const cache = createNetInstanceCache("default");
	const { harness } = await createDisk([]).open();
	onTestFinished(() => harness.close(context));
	const first = await harness.root(context);
	const middle = await Promise.all(
		Array.from({ length: 7 }, () => harness.createConversation({ ownership: { kind: "ownerless" } }, context)),
	);
	const ninth = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
	const conversations = [first, ...middle, ninth];
	const entry = { stamp: "stored", indexed: indexMarking(contested, {}) };
	for (const item of conversations.slice(0, 8)) cache.put(item.id, entry);
	cache.put(first.id, entry);
	cache.put(ninth.id, entry);
	for (const [index, item] of conversations.entries()) {
		expect(cache.take(item.id)).toBe(index === 1 ? undefined : entry);
	}
});
