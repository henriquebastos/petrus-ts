// expect: complexity
export function grade(score: number, bonus: boolean, late: boolean): string {
	if (score > 90 && bonus) return "A+";
	if (score > 90) return "A";
	if (score > 80 && !late) return "B+";
	if (score > 80) return "B";
	if (score > 70 && bonus) return "C+";
	if (score > 70) return "C";
	if (late) return "late";
	return "F";
}
