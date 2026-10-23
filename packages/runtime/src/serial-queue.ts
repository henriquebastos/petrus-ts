/** Runs work one item at a time, in call order. A failed item does not stop the items after it. */
export type SerialQueue = <TValue>(work: () => Promise<TValue>) => Promise<TValue>;

export function createSerialQueue(): SerialQueue {
	let tail: Promise<unknown> = Promise.resolve();
	return <TValue>(work: () => Promise<TValue>): Promise<TValue> => {
		const run = tail.then(work);
		tail = run.catch(() => undefined);
		return run;
	};
}
