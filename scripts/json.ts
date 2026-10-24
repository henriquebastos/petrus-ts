import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

/**
 * Parses JSON text and checks its shape. Parsed input is untrusted until the schema accepts it.
 * Properties that the schema does not name are removed, so a caller sees only the fields it declared.
 */
export function parseJson<TShape extends TSchema>(text: string, schema: TShape): Static<TShape> {
	const value = Value.Clean(schema, JSON.parse(text));
	if (!Value.Check(schema, value)) {
		const [first] = Value.Errors(schema, value);
		throw new TypeError(`JSON does not match the schema at "${first?.instancePath ?? ""}": ${first?.message ?? ""}`);
	}
	return value;
}
