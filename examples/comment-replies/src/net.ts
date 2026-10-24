import type { ColourSet, Net, Place, Transition } from "@petrus/petri-net";
import { placeId, transitionId } from "@petrus/petri-net";
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";

const id = Type.Integer({ minimum: 1 });

/**
 * A pull request that is free for an answer: one resource token per pull request. A pull request number is unique
 * only in its repository, so the token holds the repository id too.
 */
const PullRequest = Type.Object({ repo: id, pr: id }, { additionalProperties: false });

/** A comment on a pull request that waits for an answer. It holds only ids, which never change. */
const Comment = Type.Object({ repo: id, pr: id, comment: id, author: id }, { additionalProperties: false });

/** An answer that the app owes to one comment. */
const Reply = Type.Object({ repo: id, pr: id, comment: id }, { additionalProperties: false });

/** A TypeBox schema becomes a colour set through `Value.Check`, so petri-net needs no schema library. */
function colourSet(name: string, schema: TSchema): ColourSet {
	return { name, contains: (token) => Value.Check(schema, token) };
}

export const free: Place = { id: placeId("free"), colourSet: colourSet("PullRequest", PullRequest) };
export const comments: Place = { id: placeId("comments"), colourSet: colourSet("Comment", Comment) };
export const replies: Place = { id: placeId("replies"), colourSet: colourSet("Reply", Reply) };

/** The reply a comment is owed. The guard has checked the comment, so another value here is a bug in the net. */
function replyTo(value: unknown): Static<typeof Reply> {
	if (!Value.Check(Comment, value)) {
		throw new TypeError(`${JSON.stringify(value)} is not a Comment`);
	}
	return { repo: value.repo, pr: value.pr, comment: value.comment };
}

/** The comment is on the pull request of the resource token. */
function onPullRequest(comment: unknown, pull: unknown): boolean {
	return (
		Value.Check(Comment, comment) &&
		Value.Check(PullRequest, pull) &&
		comment.repo === pull.repo &&
		comment.pr === pull.pr
	);
}

/**
 * Answers a comment. It takes the pull request's resource token and gives it back, so one step answers at most one
 * comment per pull request: allocation gives the token to the first comment, and the token it gives back is new in
 * this step, so the next comment waits for the next step.
 */
const answer: Transition<"c" | "p"> = {
	id: transitionId("answer"),
	variables: { c: comments.colourSet, p: free.colourSet },
	guard: ({ c, p }) => onPullRequest(c, p),
	inputs: [
		{ place: comments, variables: ["c"] },
		{ place: free, variables: ["p"] },
	],
	outputs: [
		{ place: replies, expression: ({ c }) => [replyTo(c)] },
		{ place: free, expression: ({ p }) => [p] },
	],
};

export const net: Net = { places: [free, comments, replies], transitions: [answer] };
