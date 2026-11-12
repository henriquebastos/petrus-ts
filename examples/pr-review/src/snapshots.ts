import { createHash } from "node:crypto";
import type { ReviewFindings, ReviewWork } from "./net.ts";

// Content digests identify immutable demo snapshots, not commits in a remote repository.
function snapshot(seq: number, code: string): { readonly seq: number; readonly sha: string; readonly code: string } {
	return { seq, sha: createHash("sha256").update(code).digest("hex"), code };
}

export const snapshots = [
	snapshot(1, "export const canRead = (sameTenant, isAdmin) => sameTenant || isAdmin;"),
	snapshot(2, "// Restrict document access.\nexport const canRead = (sameTenant, isAdmin) => sameTenant || isAdmin;"),
	snapshot(3, "export const canRead = (sameTenant, isAdmin) => sameTenant && isAdmin;"),
] as const;

/** A scripted fixture, not a code analyzer or language model. */
export function scriptedReview(work: ReviewWork): ReviewFindings {
	const snapshot = snapshots.find(({ sha }) => sha === work.c.sha);
	if (snapshot === undefined) throw new Error("The selected snapshot is not in the demo");
	return snapshot.code.includes("||")
		? [
				{
					id: "tenant-access",
					note: "An administrator from another tenant can read the document. Require both conditions.",
				},
			]
		: [];
}
