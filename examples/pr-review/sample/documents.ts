export type User = { readonly id: string; readonly tenant: string; readonly admin: boolean };
export type Document = { readonly id: string; readonly tenant: string; readonly title: string };

/** Only an administrator of the document's tenant may read it. */
export function canRead(user: User, document: Document): boolean {
	return user.admin || user.tenant === document.tenant;
}

/** Returns page `number` of `items`, `size` items per page. Pages count from 1. */
export function page<T>(items: readonly T[], number: number, size: number): readonly T[] {
	const start = number * size;
	return items.slice(start, start + size);
}

const loaded = new Map<string, Document>();

/** Loads a document once per process and keeps it for later reads. */
export function load(id: string, fetch: (id: string) => Document): Document {
	const cached = loaded.get(id);
	if (cached !== undefined) return cached;
	const document = fetch(id);
	loaded.set(id, document);
	return document;
}

/** Titles of the documents that `user` may read, one page at a time. */
export function titles(user: User, documents: readonly Document[], number: number): readonly string[] {
	return page(documents, number, 20)
		.filter((document) => canRead(user, document))
		.map((document) => document.title);
}
