/** The value of an operation that can fail in an expected way. Bugs throw; expected failures return `Err`. */
export type Result<TValue, TError> = Ok<TValue> | Err<TError>;

/** A success that carries its value. */
export type Ok<TValue> = { readonly ok: true; readonly value: TValue };

/** An expected failure that carries its reason. */
export type Err<TError> = { readonly ok: false; readonly error: TError };

/** Wraps a value as a success. */
export function ok<TValue>(value: TValue): Ok<TValue> {
	return { ok: true, value };
}

/** Wraps a reason as an expected failure. */
export function err<TError>(error: TError): Err<TError> {
	return { ok: false, error };
}
