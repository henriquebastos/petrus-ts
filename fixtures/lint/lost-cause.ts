// expect: preserve-caught-error
export function readConfig(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch (error) {
		throw new Error(`bad config: ${String(error)}`);
	}
}
