/** One file of a GitHub compare response. GitHub omits `patch` for binary files and very large diffs. */
export type ChangedFile = { readonly filename: string; readonly status: string; readonly patch?: string | undefined };

/** The new-file lines of one hunk, first to last. GitHub accepts a review comment only inside one such range. */
type Hunk = { readonly first: number; readonly last: number };

/** A diff as the model reads it, with new-file line numbers, and the hunks that a comment may anchor to. */
export type Diff = { readonly text: string; readonly hunks: ReadonlyMap<string, readonly Hunk[]> };

const hunkHeader = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Numbers each context and added line with its line in the new file. A removed line has no new line.
 * Files past `budget` characters keep their name and lose their patch, so the model knows they changed.
 */
export function readDiff(files: readonly ChangedFile[], budget: number): Diff {
	const hunks = new Map<string, readonly Hunk[]>();
	const sections: string[] = [];
	let used = 0;
	for (const file of files) {
		const heading = `### ${file.filename} (${file.status})`;
		if (file.patch === undefined || used + file.patch.length > budget) {
			sections.push(
				`${heading}\nPatch omitted: ${file.patch === undefined ? "GitHub sent none" : "diff too large"}.`,
			);
			continue;
		}
		used += file.patch.length;
		const numbered = numberPatch(file.patch);
		hunks.set(file.filename, numbered.hunks);
		sections.push(`${heading}\n${numbered.lines.join("\n")}`);
	}
	return { text: sections.join("\n\n"), hunks };
}

/** True when lines `start` to `end` of `path` lie in one hunk, the rule GitHub applies to review comments. */
export function anchors(diff: Diff, path: string, start: number, end: number): boolean {
	return (diff.hunks.get(path) ?? []).some(({ first, last }) => first <= start && start <= end && end <= last);
}

function numberPatch(patch: string): { readonly lines: readonly string[]; readonly hunks: readonly Hunk[] } {
	const lines: string[] = [];
	const hunks: Hunk[] = [];
	let next = 0;
	for (const line of patch.split("\n")) {
		const header = hunkHeader.exec(line);
		if (header === null) {
			lines.push(oldOnly(line) ? `      ${line}` : `${String(next++).padStart(5)} ${line}`);
			continue;
		}
		next = Number(header[1]);
		hunks.push(...hunkFrom(next, Number(header[2] ?? "1")));
		lines.push(line);
	}
	return { lines, hunks };
}

/** A removed line, or the marker for a missing newline at the end of a file, has no line in the new file. */
function oldOnly(line: string): boolean {
	return line.startsWith("-") || line.startsWith("\\");
}

function hunkFrom(first: number, count: number): readonly Hunk[] {
	return count > 0 ? [{ first, last: first + count - 1 }] : [];
}
