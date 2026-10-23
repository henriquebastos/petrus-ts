// expect: no-empty
export function tryParse(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {}
	return undefined;
}
