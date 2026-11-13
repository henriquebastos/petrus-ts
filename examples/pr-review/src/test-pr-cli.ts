// Test pull requests for `petrus review`, made through the GitHub API with the user's `gh` login:
//   test-pr open [OWNER/REPO]       a new branch and pull request with revision A (default henriquebastos/petrus-ts)
//   test-pr push <URL> <B|C>       commit that revision on the pull request's branch
//   test-pr close <URL>            close the pull request and delete its branch
// The composition root of the tool: the only file that reads arguments and makes randomness.
import { randomUUID } from "node:crypto";
import { ghProcess, parsePullUrl } from "./github.ts";
import { branchPrefix, closeTestPr, openTestPr, pushRevision, revisions } from "./test-pr.ts";

const usage = "usage: test-pr open [OWNER/REPO] | test-pr push <URL> <B|C> | test-pr close <URL>";
const gh = ghProcess("gh");
const [verb, target = "henriquebastos/petrus-ts", revision] = process.argv.slice(2);
if (verb === "open") {
	const [owner = "", repo = ""] = target.split("/");
	const opened = await openTestPr(gh, { owner, repo }, `${branchPrefix}${randomUUID().slice(0, 8)}`);
	console.log(opened.url);
} else if (verb === "push" && (revision === "B" || revision === "C")) {
	console.log(
		`${revision}: ${await pushRevision(gh, parsePullUrl(target), revision)} (${revisions[revision].message})`,
	);
} else if (verb === "close") {
	await closeTestPr(gh, parsePullUrl(target));
	console.log(`Closed ${target}`);
} else {
	throw new Error(usage);
}
