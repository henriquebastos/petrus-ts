import type { JsonValue } from "@earendil-works/chord";
import { BrokenNetInstance } from "./net-instance.ts";

export type IngressBuckets = JsonValue[][];

const ingressBucketCount = 1024;

/** Request ids hash UTF-16 code units, including unpaired surrogates. */
export function ingressBucketOf(id: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < id.length; index++) {
		hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193);
	}
	return hash & (ingressBucketCount - 1);
}

/** Builds sorted buckets once; repeated ids retain their last log index. */
export function buildIngressIndex(entries: Iterable<readonly [string, number]>): IngressBuckets {
	const pairs: [string, number][][] = Array.from({ length: ingressBucketCount }, () => []);
	for (const [id, index] of new Map(entries)) {
		pairs[ingressBucketOf(id)]?.push([id, index]);
	}
	return pairs.map((bucket) => bucket.sort(([left], [right]) => compareIngressIds(left, right)).flat());
}

/** Request ids sort by UTF-16 code units, with equal ids comparing as zero. */
export function compareIngressIds(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function bucketFor(buckets: IngressBuckets, id: string): JsonValue[] {
	const bucket = buckets[ingressBucketOf(id)];
	if (bucket === undefined) {
		throw new BrokenNetInstance("an ingress index needs 1024 buckets");
	}
	return bucket;
}

function positionOf(bucket: JsonValue[], id: string): number {
	let low = 0;
	let high = bucket.length / 2;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = bucket[middle * 2];
		if (typeof candidate !== "string") {
			throw new BrokenNetInstance("an ingress bucket needs request id and log index pairs");
		}
		if (candidate < id) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}
	return low * 2;
}

/** Reads scalar pairs without copying a bucket. */
export function ingressIndexOf(buckets: IngressBuckets, id: string): number | undefined {
	const bucket = bucketFor(buckets, id);
	const position = positionOf(bucket, id);
	const index = bucket[position + 1];
	return bucket[position] === id && typeof index === "number" ? index : undefined;
}

/** Changes only the bucket that owns the request id. */
export function insertIngress(buckets: IngressBuckets, id: string, index: number): void {
	const bucket = bucketFor(buckets, id);
	const position = positionOf(bucket, id);
	bucket.splice(position, bucket[position] === id ? 2 : 0, id, index);
}
