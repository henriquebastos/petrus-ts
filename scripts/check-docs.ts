/**
 * Docs describe this repository as it is now, in small files that an agent can read whole. This script checks:
 * - each Markdown file has at most `wordLimit` words;
 * - no text file names a place outside the repository (a home directory or the outside discussion notes);
 * - each repository path that a Markdown file names exists;
 * - each quoted text that a Markdown file cites from a file, written `path` "text", is in that file. A citation
 *   may wrap to the next line of its paragraph.
 * `fixtures/` (planted defects) and the generated API reports are not checked. Run from the repository root
 * (the gate test runs it from a sandbox copy).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const wordLimit = 1500;
const skippedDirectories = new Set([
	"node_modules",
	".git",
	"coverage",
	"reports",
	".stryker-tmp",
	".fallow",
	"fixtures",
]);
const textFile = /\.(md|ts|js|cjs|mjs|json|jsonc|yaml|yml)$/;
const outsidePlaces = [/\bconduits?\b/i, /obsidian:\/\//i, /\/Users\//, /\/vault\//i];
const inlinePath = /^\.?[\w@-][\w.@-]*(\/[\w.@-]+)*\/?$/;
const fileName = /^\.?[^.]+.*\.(md|ts|js|cjs|mjs|json|jsonc|yaml|yml)$/;
const self = relative(process.cwd(), import.meta.filename);

/** Planted defects, tool output and the generated API reports are not docs. */
function checkedDirectory(path: string, name: string): boolean {
	return !skippedDirectories.has(name) && !path.endsWith("/api");
}

function checkedFile(name: string): boolean {
	return textFile.test(name) && name !== "pnpm-lock.yaml";
}

/** Every text file under `directory`, as a path relative to the root. */
function textFiles(directory: string): readonly string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			return checkedDirectory(path, entry.name) ? textFiles(path) : [];
		}
		return checkedFile(entry.name) ? [path] : [];
	});
}

/** `packages/x/` or `examples/x/` for a file in a package, so a package doc can name `src/index.ts`. */
function packageRoot(file: string): string | undefined {
	const match = /^(packages|examples)\/[^/]+\//.exec(file);
	return match?.[0];
}

/** A path with folders, or a bare file name. A package name (`@petrus/x`) is not a path. */
function looksLikePath(text: string): boolean {
	return inlinePath.test(text) && !text.startsWith("@") && (text.includes("/") || fileName.test(text));
}

/** The doc's package root or the repository root, whichever holds the path's first segment. */
function rootHolding(file: string, path: string): string | undefined {
	const first = path.split("/", 1)[0] ?? path;
	return [packageRoot(file), ""].find((root) => root !== undefined && existsSync(join(root, first)));
}

/**
 * The file that an inline path means, or undefined when the text is not a repository path.
 * A path with folders counts when its first segment exists. A bare file name always counts.
 */
function resolvePath(file: string, text: string): string | undefined {
	if (!looksLikePath(text)) {
		return undefined;
	}
	const root = rootHolding(file, text);
	if (root !== undefined) {
		return join(root, text);
	}
	return text.includes("/") ? undefined : text;
}

function wordProblems(file: string, content: string): readonly string[] {
	const words = content.split(/\s+/).filter((word) => word !== "").length;
	return words > wordLimit ? [`${file} has ${String(words)} words, limit ${String(wordLimit)}`] : [];
}

function outsideProblems(file: string, lines: readonly string[]): readonly string[] {
	return lines.flatMap((line, index) =>
		outsidePlaces.some((place) => place.test(line))
			? [`${file}:${String(index + 1)} names a place outside the repository`]
			: [],
	);
}

/** The paths, links and citations on one line of prose, or on a `// path` line in a code block. */
function referencesOn(line: string, inCode: boolean): readonly { readonly text: string; readonly link: boolean }[] {
	if (inCode) {
		const comment = /^\s*\/\/ (\S+)$/.exec(line);
		return comment?.[1] === undefined ? [] : [{ text: comment[1], link: false }];
	}
	const inline = [...line.matchAll(/`([^`]+)`/g)].map((match) => ({ text: match[1] ?? "", link: false }));
	const links = [...line.matchAll(/\]\(([^)#:]+)(#[^)]*)?\)/g)].map((match) => ({ text: match[1] ?? "", link: true }));
	return [...inline, ...links];
}

function missingProblems(file: string, lines: readonly string[]): readonly string[] {
	let inCode = false;
	return lines.flatMap((line, index) => {
		if (line.trimStart().startsWith("```")) {
			inCode = !inCode;
			return [];
		}
		return referencesOn(line, inCode).flatMap(({ text, link }) => {
			const target = link ? join(dirname(file), text) : resolvePath(file, text);
			return target === undefined || existsSync(target)
				? []
				: [`${file}:${String(index + 1)} names ${text}, which does not exist`];
		});
	});
}

/** A citation of a missing file holds here: `missingProblems` reports the path. */
function citationHolds(file: string, path: string, quote: string): boolean {
	const target = resolvePath(file, path);
	if (target === undefined || !existsSync(target) || !statSync(target).isFile()) {
		return true;
	}
	return readFileSync(target, "utf8").includes(quote);
}

/** Prose lines of one paragraph, joined by spaces, and the index of its first line. */
type Paragraph = { readonly start: number; readonly text: string };

/**
 * A prose line that goes on the paragraph above it. Only a blank line ends a paragraph: markdownlint puts blank
 * lines round headings and code blocks.
 */
function continuesParagraph(lines: readonly string[], index: number, inCode: boolean): boolean {
	const blank = (line: string | undefined): boolean => line === undefined || line.trim() === "";
	return !inCode && !blank(lines[index]) && !blank(lines[index - 1]);
}

/** The paragraphs of a Markdown file. Each code line is a paragraph of its own, so code never joins prose. */
function paragraphs(lines: readonly string[]): readonly Paragraph[] {
	const found: { start: number; text: string }[] = [];
	let inCode = false;
	lines.forEach((line, index) => {
		const last = found.at(-1);
		if (last !== undefined && continuesParagraph(lines, index, inCode)) {
			last.text = `${last.text} ${line.trim()}`;
		} else {
			found.push({ start: index, text: line });
		}
		inCode = line.trimStart().startsWith("```") ? !inCode : inCode;
	});
	return found;
}

function citationProblems(file: string, lines: readonly string[]): readonly string[] {
	return paragraphs(lines).flatMap(({ start, text }) =>
		[...text.matchAll(/`([^`]+)` "([^"]+)"/g)].flatMap(([, path = "", quote = ""]) =>
			citationHolds(file, path, quote)
				? []
				: [`${file}:${String(start + 1)} cites "${quote}", which ${path} does not contain`],
		),
	);
}

function problems(file: string): readonly string[] {
	const content = readFileSync(file, "utf8");
	const lines = content.split("\n");
	const outside = file === self ? [] : outsideProblems(file, lines);
	if (!file.endsWith(".md")) {
		return outside;
	}
	return [
		...wordProblems(file, content),
		...outside,
		...missingProblems(file, lines),
		...citationProblems(file, lines),
	];
}

const found = textFiles(".")
	.map((file) => relative(".", file))
	.flatMap(problems)
	.sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
if (found.length > 0) {
	console.error(found.join("\n"));
	console.error(`${String(found.length)} docs problem(s).`);
	process.exitCode = 1;
}
