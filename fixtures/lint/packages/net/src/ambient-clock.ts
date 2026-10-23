// expect: no-restricted-properties no-restricted-syntax no-restricted-globals
export function stamp(): number {
	setTimeout(() => undefined, 0);
	return Date.now() + new Date().getTime();
}
