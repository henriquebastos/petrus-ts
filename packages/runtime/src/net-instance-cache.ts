import type { ConversationId } from "@earendil-works/pi-durable";
import type { IndexedMarking } from "@petrus/petri-net";

type CachedInstance = { readonly stamp: string; readonly indexed: IndexedMarking };

/** Taking an entry transfers ownership. A failed commit cannot reuse its partially changed index. */
export type NetInstanceCache = {
	readonly take: (conversation: ConversationId) => CachedInstance | undefined;
	readonly put: (conversation: ConversationId, entry: CachedInstance) => void;
	readonly nextStamp: () => string;
};

/**
 * Eight cached 3,000-philosopher indexes retained 45.18 MiB after GC, versus 180.25 MiB for 32.
 * The default bounds the instance count, not bytes. Tests can use zero capacity to force rebuilding.
 */
export function createNetInstanceCache(nonce: string, capacity = 8): NetInstanceCache {
	const entries = new Map<ConversationId, CachedInstance>();
	let attempt = 0;
	return {
		take: (conversation) => {
			const entry = entries.get(conversation);
			entries.delete(conversation);
			return entry;
		},
		put: (conversation, entry) => {
			entries.delete(conversation);
			entries.set(conversation, entry);
			if (entries.size > capacity) {
				for (const oldest of entries.keys()) {
					entries.delete(oldest);
					break;
				}
			}
		},
		nextStamp: () => {
			attempt += 1;
			return `${nonce}-${attempt.toString(16).padStart(16, "0")}`;
		},
	};
}
