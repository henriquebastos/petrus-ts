import type { Batch } from "@petrus/runtime";
import type { Static } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { comments, free } from "./net.ts";

/**
 * One webhook delivery as the app's HTTP edge receives it: the `X-GitHub-Delivery` header, the `X-GitHub-Event`
 * header, and the JSON body, which is untrusted until a schema accepts it.
 */
export const Delivery = Type.Object({ id: Type.String(), event: Type.String(), payload: Type.Unknown() });
export type Delivery = Static<typeof Delivery>;

const repository = Type.Object({ id: Type.Integer() });

/** The part of a `pull_request` payload that the app reads. GitHub sends more fields; they are ignored. */
const Opened = Type.Object({
	action: Type.Literal("opened"),
	repository,
	pull_request: Type.Object({ number: Type.Integer() }),
});

/** The part of an `issue_comment` payload that the app reads. `issue.pull_request` is there only on a pull request. */
const Commented = Type.Object({
	action: Type.Literal("created"),
	repository,
	issue: Type.Object({ number: Type.Integer(), pull_request: Type.Object({}) }),
	comment: Type.Object({ id: Type.Integer(), user: Type.Object({ id: Type.Integer() }) }),
});

export type Translated =
	| { readonly kind: "batch"; readonly batch: Batch }
	| { readonly kind: "ignored"; readonly reason: string };

/**
 * Turns a delivery into a batch, or says why the app ignores it.
 *
 * The request id names the fact, not the delivery: `comment:<id>` (comment ids are unique on GitHub) and
 * `pull-request:<repository id>/<number>`. A redelivery has the same delivery id, so the delivery id would do for
 * redeliveries. But a poll that finds the same comment, or a second event about it, comes with another delivery id,
 * and only an id built from the fact's own ids makes all of them one batch. The tokens hold only ids, which never
 * change, so every arrival of the fact has the same tokens; a name such as the login could change.
 */
export function toBatch(delivery: Delivery): Translated {
	const { event, payload } = delivery;
	if (event === "pull_request" && Value.Check(Opened, payload)) {
		const pull = { repo: payload.repository.id, pr: payload.pull_request.number };
		const requestId = `pull-request:${String(pull.repo)}/${String(pull.pr)}`;
		return { kind: "batch", batch: { requestId, tokens: { [free.id]: [pull] } } };
	}
	if (event === "issue_comment" && Value.Check(Commented, payload)) {
		const { repository: repo, issue, comment } = payload;
		const token = { repo: repo.id, pr: issue.number, comment: comment.id, author: comment.user.id };
		return {
			kind: "batch",
			batch: { requestId: `comment:${String(comment.id)}`, tokens: { [comments.id]: [token] } },
		};
	}
	return { kind: "ignored", reason: `${event} is not an opened pull request or a new pull request comment` };
}
