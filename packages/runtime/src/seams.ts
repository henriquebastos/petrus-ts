/** Time enters the runtime only through this seam, so tests and simulations control it. */
export type Clock = { readonly now: () => number };
