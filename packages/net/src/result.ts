/** The value of an operation that can fail in an expected way. Bugs throw; expected failures return `Err`. */
export type Result<TValue, TError> = Ok<TValue> | Err<TError>;

export type Ok<TValue> = { readonly ok: true; readonly value: TValue };

export type Err<TError> = { readonly ok: false; readonly error: TError };

export function ok<TValue>(value: TValue): Ok<TValue> {
	return { ok: true, value };
}

export function err<TError>(error: TError): Err<TError> {
	return { ok: false, error };
}
