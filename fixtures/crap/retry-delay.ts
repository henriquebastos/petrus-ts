// Planted defect: cyclomatic complexity 8 and no test, so CRAP = 8² × (1 − 0)³ + 8 = 72.
export function retryDelay(attempt: number): number {
	if (attempt <= 0) {
		return 0;
	}
	if (attempt === 1) {
		return 100;
	}
	if (attempt === 2) {
		return 250;
	}
	if (attempt === 3) {
		return 500;
	}
	if (attempt === 4) {
		return 1_000;
	}
	if (attempt === 5) {
		return 2_000;
	}
	if (attempt === 6) {
		return 4_000;
	}
	return 8_000;
}
