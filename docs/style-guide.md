# Style guide

Good code here lets the reader see the domain, follow one operation, and see where effects happen.

Tools enforce most rules: `tsc` (`tsconfig.base.json`), ESLint (`eslint.config.js`), dependency-cruiser
(`.dependency-cruiser.cjs`), knip and api-extractor. Their error messages and config comments give the reason.
This guide holds the rules that a reviewer checks. Each rule cites the pattern it comes from, in this order of
authority: Dan Vanderkam, _Effective TypeScript_, 2nd edition; Matt Pocock, _Total TypeScript_ and his rule files;
typescript-eslint `strict-type-checked`.

## Model the domain with types

### A finite state is a discriminated union

Each state carries only the fields that are true in that state. In a `default` branch that must never run,
write `value satisfies never`.

```ts
// packages/runtime/src/runtime.ts
export type StepFailure = NotEnabled | UnknownTransition;
```

Pattern: Vanderkam Item 29 "Prefer Types That Always Represent Valid States"; Pocock "satisfies never".

### Expected failures are values; bugs throw

A caller must handle a `Result`. It cannot forget a failure that the type shows.

```ts
// packages/petri-net/src/fire.ts
export function fire(transition: Transition, marking: Marking): Result<Marking, NotEnabled> {
```

Throw only `Error` objects, and only for bugs and infrastructure failures (a store that is down).
Keep the original error as `cause` when you wrap it.

Pattern: Pocock rule `throwing`; Vanderkam Item 29.

### Brand ids that have the same shape but a different meaning

A `PlaceId` and a `TransitionId` are both strings. The brand stops one from being used as the other.
The brand constructor is the only place with an `as` cast, and it carries a reasoned suppression.

```ts
// packages/petri-net/src/ids.ts
export type PlaceId = string & { readonly __brand: "PlaceId" };
```

Pattern: Vanderkam Item 64 "Consider Brands for Nominal Typing".

### Data is readonly

Functions return new values. Nobody changes a marking behind another function's back. Write new types `readonly`.

```ts
// packages/petri-net/src/marking.ts
export type Marking = Readonly<Record<PlaceId, number>>;
```

Pattern: Vanderkam Item 14; Pocock rule `readonly-properties`.

### Required fields over optional ones

Use `field: T | undefined` when absence matters, so every caller must decide. Use `?:` only when a missing field
is truly harmless. Seams such as the clock are required, never optional with a hidden default.

Pattern: Vanderkam Item 37 "Limit the Use of Optional Properties"; Pocock rule `optional-properties`.

## Modules

- Files use kebab-case.
- A package root re-exports its public names one by one. A name that only tests use stays out of the root.

Pattern: Pocock rule `naming-conventions`.

## Tests

- Test behaviour through the public functions. Replace slow or nondeterministic collaborators with typed fakes
  passed in.
- Add a fast-check property next to the examples when a function has a rule that holds for all inputs.
  Stateful code gets a model-based test against an independent model (`packages/petri-net/test/model-property.ts`).
- A test title states the behaviour, because a spec cites it.
- Coverage is a floor (statements, lines and functions 90%, branches 85%), not a goal. Every test asserts.
- Every quality gate has a planted defect in `fixtures/` and a gate test in `test/gates/`. A gate test asserts the
  exact findings, so a gate that stops checking fails.

## Readability

- Comments say why, or state an invariant that the code cannot show. A JSDoc line on an exported name states its
  contract.
- Split a function when it does two things, before the complexity limit forces it.
