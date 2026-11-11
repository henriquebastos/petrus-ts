import fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
	buildIngressIndex,
	compareIngressIds,
	ingressBucketOf,
	ingressIndexOf,
	insertIngress,
} from "../src/ingress-index.ts";
import { BrokenNetInstance } from "../src/net-instance.ts";

const requestId = fc.oneof(
	fc.string(),
	fc.array(fc.integer({ min: 0, max: 65535 })).map((units) => String.fromCharCode(...units)),
	fc.constantFrom("__proto__", "constructor", "é😀", "", "request:x"),
);

describe("the ingress buckets", () => {
	test("compares request ids in UTF-16 order, including equal ids and reversed pairs", () => {
		fc.assert(
			fc.property(requestId, requestId, (left, right) => {
				const ordered = [...new Set([left, right])].sort();
				const expected = ordered.indexOf(left) - ordered.indexOf(right);
				expect(compareIngressIds(left, right)).toBe(expected);
				expect(compareIngressIds(right, left)).toBe(0 - expected);
				expect(compareIngressIds(left, left)).toBe(0);
			}),
		);
		expect(compareIngressIds("\ud800", "\ud800\udc00")).toBe(-1);
		expect(compareIngressIds("😀", "\uffff")).toBe(-1);
	});

	test("fixes the FNV-1a hash over UTF-16 code units", () => {
		expect(["", "a", "foobar", "é", "😀", "\ud800"].map(ingressBucketOf)).toStrictEqual([
			453, 300, 360, 68, 184, 287,
		]);
	});

	test("bucket lookups agree with a reference object index for arbitrary request ids", () => {
		fc.assert(
			fc.property(fc.array(requestId), requestId, (randomIds, absent) => {
				const ids = [...randomIds, "__proto__", "constructor", "é😀"];
				const entries = ids.map((id, index): [string, number] => [id, index]);
				const old: Record<string, number> = Object.fromEntries(
					entries.map(([id, index]) => [`request:${id}`, index]),
				);
				const built = buildIngressIndex(entries);
				const inserted = buildIngressIndex([]);
				for (const [id, index] of entries) insertIngress(inserted, id, index);
				expect(inserted).toStrictEqual(built);
				for (const id of [...ids, absent]) {
					expect(ingressIndexOf(inserted, id)).toBe(old[`request:${id}`]);
				}
			}),
		);
	});

	test("keeps colliding ids sorted and replaces only the existing pair for a repeated id", () => {
		const ids = Array.from({ length: 20000 }, (_, index) => `id:${String(index)}`).filter(
			(id) => ingressBucketOf(id) === ingressBucketOf("id:0"),
		);
		expect(ids.length).toBeGreaterThan(5);
		const buckets = buildIngressIndex([]);
		for (const id of ids.toReversed()) insertIngress(buckets, id, 1);
		insertIngress(buckets, "id:0", 9);
		expect(buckets[ingressBucketOf("id:0")]).toStrictEqual(
			ids.toSorted().flatMap((id) => [id, id === "id:0" ? 9 : 1]),
		);
		for (const id of ids) expect(ingressIndexOf(buckets, id)).toBe(id === "id:0" ? 9 : 1);
	});

	test("builds sorted colliding pairs and finds no ingress for a missing colliding id", () => {
		const ids = ["id:0", "id:1021", "id:10463", "id:10690", "id:11114"];
		expect(new Set(ids.map(ingressBucketOf)).size).toBe(1);
		const entries: [string, number][] = [
			["id:10690", 7],
			["id:1021", 2],
			["id:10690", 9],
		];
		const built = buildIngressIndex(entries);
		const inserted = buildIngressIndex([]);
		for (const [id, index] of entries) insertIngress(inserted, id, index);
		for (const buckets of [built, inserted]) {
			expect(buckets[ingressBucketOf("id:0")]).toStrictEqual(["id:1021", 2, "id:10690", 9]);
			expect(ids.map((id) => ingressIndexOf(buckets, id))).toStrictEqual([undefined, 2, undefined, 9, undefined]);
		}
	});

	test("rejects a missing bucket or a non-string request id in a searched pair", () => {
		expect(() => ingressIndexOf([], "x")).toThrow(new BrokenNetInstance("an ingress index needs 1024 buckets"));
		const buckets = buildIngressIndex([]);
		buckets[ingressBucketOf("x")] = [null, 0];
		expect(() => ingressIndexOf(buckets, "x")).toThrow(
			new BrokenNetInstance("an ingress bucket needs request id and log index pairs"),
		);
		buckets[ingressBucketOf("x")] = ["x", null];
		expect(ingressIndexOf(buckets, "x")).toBeUndefined();
	});
});
