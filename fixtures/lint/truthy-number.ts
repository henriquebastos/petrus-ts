// expect: @typescript-eslint/strict-boolean-expressions
export function hasTimeout(timeoutMs: number | undefined): boolean {
	if (timeoutMs) {
		return true;
	}
	return false;
}
