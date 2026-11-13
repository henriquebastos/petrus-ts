import type { Context } from "@earendil-works/chord/context";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export type ModelAccess = Pick<Models, "getModel" | "completeSimple">;

/** The request limits of one review. `maxRetries` counts the SDK's own retries of a failed request. */
export type Limits = { readonly maxTokens: number; readonly maxRetries: number };

export function opusOf(models: ModelAccess): Model<Api> {
	const model = models.getModel("anthropic", "claude-opus-5-5");
	if (model === undefined) throw new Error("Anthropic Claude Opus 5.5 is not registered");
	return model;
}

/** Asks for JSON and returns it only when the reply finished and matches `schema`. Anything else throws. */
export async function completeJson<T extends TSchema>(
	models: ModelAccess,
	request: { readonly systemPrompt: string; readonly content: string; readonly limits: Limits },
	schema: T,
	context: Context,
): Promise<Static<T>> {
	const response = await models.completeSimple(
		opusOf(models),
		{
			systemPrompt: request.systemPrompt,
			messages: [{ role: "user", content: request.content, timestamp: 0 }],
		},
		{
			...request.limits,
			timeoutMs: 120000,
			...(context.abortSignal === undefined ? {} : { signal: context.abortSignal }),
		},
	);
	if (response.stopReason !== "stop") throw new Error(`Review did not finish: ${response.stopReason}`);
	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	const parsed: unknown = JSON.parse(text);
	if (!Value.Check(schema, parsed)) throw new Error("Review findings do not match the schema");
	return Value.Parse(schema, parsed);
}
