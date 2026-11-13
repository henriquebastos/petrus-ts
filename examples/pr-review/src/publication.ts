import type { ReviewComment, ReviewPayload } from "./github.ts";
import type { HostFinding, HostReport } from "./host-net.ts";

type LineFinding = Extract<HostFinding, { readonly kind: "line" }>;

/** Names one report on the pull request, so a repeated publication finds the review that it already posted. */
export function marker(report: Pick<HostReport, "seq" | "sha">): string {
	return `<!-- petrus-review seq=${String(report.seq)} sha=${report.sha} -->`;
}

const short = (sha: string): string => `\`${sha.slice(0, 7)}\``;
const findings = (count: number): string => `${String(count)} finding${count === 1 ? "" : "s"}`;

/**
 * One review on the report's own commit. Line findings become comments on the diff, design findings a list in the
 * body. Every review carries the source commit, its author's login and the marker, also when it has no findings.
 */
export function renderReview(report: HostReport, author: string): ReviewPayload {
	const lines = report.findings.filter((finding) => finding.kind === "line");
	const designs = report.findings.filter((finding) => finding.kind === "design");
	const body = [
		`### Petrus review of ${short(report.sha)}`,
		summary(report, lines.length),
		...(designs.length === 0 ? [] : [designs.map(({ id, note }) => `- **${id}**: ${note}`).join("\n")]),
		...carried(report),
		`Posted by \`petrus review\` as @${author}.\n${marker(report)}`,
	].join("\n\n");
	return { commit_id: report.sha, event: "COMMENT", body, comments: lines.map(comment) };
}

function summary(report: HostReport, lineCount: number): string {
	if (report.findings.length === 0) return `No findings at ${short(report.sha)}.`;
	return `${findings(report.findings.length)}, ${String(lineCount)} as comments on the diff.`;
}

function carried(report: HostReport): readonly string[] {
	const counts = new Map<string, number>();
	for (const { since } of report.findings) {
		if (since !== report.sha) counts.set(since, (counts.get(since) ?? 0) + 1);
	}
	return [...counts].map(([since, count]) => `${findings(count)} first reported at ${short(since)}.`);
}

function comment(finding: LineFinding): ReviewComment {
	const at = { path: finding.path, line: finding.line, side: "RIGHT", body: commentBody(finding) } as const;
	return finding.startLine === finding.line ? at : { ...at, start_line: finding.startLine, start_side: "RIGHT" };
}

/** The fence is longer than any backtick run in the suggestion, so the suggestion cannot close it early. */
function commentBody({ note, suggestion }: LineFinding): string {
	if (suggestion === "") return note;
	const longest = Math.max(0, ...(suggestion.match(/`+/g) ?? []).map((run) => run.length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${note}\n\n${fence}suggestion\n${suggestion.replace(/\n$/, "")}\n${fence}`;
}
