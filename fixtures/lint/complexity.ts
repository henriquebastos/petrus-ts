// expect: complexity
// Complexity 6, one above the limit of 5. If the limit rises, this file stops failing and the lint gate test fails.
export function grade(score: number, late: boolean): string {
	if (late) return "late";
	if (score > 90) return "A";
	if (score > 80) return "B";
	if (score > 70) return "C";
	if (score > 60) return "D";
	return "F";
}
