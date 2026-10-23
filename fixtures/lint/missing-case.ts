// expect: @typescript-eslint/switch-exhaustiveness-check
type Status = "pending" | "running" | "failed";

export function report(status: Status, log: (line: string) => void): void {
	switch (status) {
		case "pending":
			log("waiting");
			break;
		case "running":
			log("busy");
			break;
	}
}
