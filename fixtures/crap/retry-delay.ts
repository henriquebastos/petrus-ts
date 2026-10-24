// Planted defect: cyclomatic complexity 3 and no test, so CRAP = 3² × (1 − 0)³ + 3 = 12.
// ESLint allows complexity 3, so only the CRAP limit of 10 catches it. At the old limit of 30 it would pass.
// The limit of 10 keeps the old rule at the new complexity limit: a function at the limit (5) fails below about 42% coverage.
export function retryDelay(attempt: number): number {
	if (attempt <= 0) {
		return 0;
	}
	if (attempt === 1) {
		return 100;
	}
	return 250;
}
