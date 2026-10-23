# Style guide

Good code here lets the reader see the domain, follow one operation, and see where effects happen.
The type checker and the linter enforce most rules below; the "Enforced by" line names the check.
A rule with no check is a review rule.

Each rule cites the pattern it comes from. The order of authority is:

1. Dan Vanderkam, _Effective TypeScript_, 2nd edition, for type design.
2. Matt Pocock, _Total TypeScript_, his rule files and tsconfig cheat sheet, for short concrete rules.
3. typescript-eslint `strict-type-checked` and `stylistic-type-checked`, as the mechanical arbiter.

The conduit note `03-expand/foundations/explained/` has a bad and a good example for every rule, with the real tool output.
Exceptions to the base configs are in [decision 0003](decisions/0003-lint-gaps.md).

## Model the domain with types

### A finite state is a discriminated union

Each state carries only the fields that are true in that state. A `switch` over the tag must handle every case.

```ts
// packages/runtime/src/runtime.ts
export type StepFailure = NotEnabled | UnknownTransition;
// NotEnabled has kind "not-enabled"; UnknownTransition has kind "unknown-transition".
```

In a `default` branch that must never run, write `failure satisfies never`.

- Enforced by: `tsc`; `@typescript-eslint/switch-exhaustiveness-check`.
- Pattern: Vanderkam Item 29 "Prefer Types That Always Represent Valid States", Item 34; Pocock "satisfies never".

### Expected failures are values; bugs throw

A caller must handle a `Result`. It cannot forget a failure that the type shows.

```ts
// packages/net/src/fire.ts
export function fire(transition: Transition, marking: Marking): Result<Marking, NotEnabled>;
```

Throw only `Error` objects, and only for bugs and infrastructure failures (a store that is down).
Keep the original error as `cause` when you wrap it.

- Enforced by: `tsc` (a caller cannot read `.value` before it checks `.ok`); `only-throw-error`; `preserve-caught-error`; `no-empty`.
- Pattern: Pocock rule `throwing`; Vanderkam Item 29.

### Brand ids that have the same shape but a different meaning

A `PlaceId` and a `TransitionId` are both strings. The brand stops one from being used as the other.

```ts
// packages/net/src/ids.ts
export type PlaceId = string & { readonly __brand: "PlaceId" };
```

The brand constructor is the only place with an `as` cast, and it carries a reasoned suppression.

- Enforced by: `tsc`, once the ids are branded.
- Pattern: Vanderkam Item 64 "Consider Brands for Nominal Typing".

### Data is readonly

Functions return new values. Nobody changes a marking behind another function's back.

```ts
// packages/net/src/marking.ts
export type Marking = Readonly<Record<PlaceId, number>>;
```

- Enforced by: `tsc`, once the types are `readonly`; review for new types.
- Pattern: Vanderkam Item 14; Pocock rule `readonly-properties`.

### Required fields over optional ones

Use `field: T | undefined` when absence matters, so every caller must decide. Use `?:` only when a missing field is truly harmless.
Seams such as the clock are required, never optional with a hidden default.

- Enforced by: `tsc` with `exactOptionalPropertyTypes`; review.
- Pattern: Vanderkam Item 37 "Limit the Use of Optional Properties"; Pocock rule `optional-properties`.

### `type` by default; `interface` only to extend

- Enforced by: `no-restricted-syntax` (an `interface` without `extends`).
- Pattern: Pocock rule `interface-extends` and his article "Type vs Interface".

### Only erasable syntax

No `enum`, `namespace` or constructor parameter properties. Use a union of string literals or an `as const` object.

- Enforced by: `tsc` `erasableSyntaxOnly`.
- Pattern: Vanderkam Item 72 "Prefer ECMAScript Features to TypeScript Features"; Pocock rule `enums`.

## Keep the type checker on

### No `any`, and no `as` that lies

Untrusted input (a webhook body, a stored document, tool output) is `unknown` until a schema accepts it.

```ts
// test/gates/dependencies.test.ts
return cruiseOutput.parse(JSON.parse(run.stdout)); // a Zod schema, not `as CruiseOutput`
```

Use an annotation or `satisfies` for literals, never `{ ... } as T`.

- Enforced by: `no-explicit-any`, `no-unsafe-*`, `no-unsafe-type-assertion`, `consistent-type-assertions`.
- Pattern: Vanderkam Items 43 to 46; Pocock: "`as` lets you lie to TypeScript".

### Index reads can miss

`marking[place]` is `number | undefined`. Handle the missing case; do not use `!`.

```ts
// packages/net/src/marking.ts
return marking[place] ?? 0;
```

- Enforced by: `tsc` `noUncheckedIndexedAccess`; `no-non-null-assertion`.
- Pattern: Pocock rule `no-unchecked-indexed-access`.

### Do not test a number for truth

`if (timeoutMs)` is false for `0`. Compare: `if (timeoutMs !== undefined)`.

- Enforced by: `strict-boolean-expressions`, with numbers banned and strings allowed. The rule's defaults also reject
  `any`, nullable booleans, and objects that are always truthy.
- Pattern: TypeScript Handbook, narrowing; decision 0003.

### Every suppression has a reason

```ts
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- brand constructor: the only place that creates a PlaceId
```

No `@ts-ignore`. Use `@ts-expect-error -- reason` when a suppression is necessary.

- Enforced by: `eslint-comments/require-description`; `ban-ts-comment`; unused suppressions fail the lint.

## Async code

### Await or handle every promise

A commit that nobody awaits can fail without a trace, or land after the code moved on.

- Enforced by: `no-floating-promises`, `no-misused-promises`, `return-await`.
- Pattern: typescript-eslint `strict-type-checked`.

### One writer at a time

The runtime runs steps through a serial queue, so two steps never read the same marking.
Change concurrency only with a scheduler property test (see "Tests").

- Enforced by: `packages/runtime/test/properties.ts` `raceProperty`.

## Modules and packages

- Named exports only. Exception: tool config files that require a default export.
- Types come in through a top-level `import type { ... }` line.
- Relative imports name the `.ts` file. Node runs the source.
- A package root re-exports its names one by one; no `export *`.
- Exported and top-level functions declare their return type.
- Files use kebab-case (a review rule: no tool checks file names).

Enforced by: `no-restricted-syntax`, `no-restricted-imports`, `consistent-type-imports`, `no-import-type-side-effects`,
`explicit-function-return-type`, `explicit-module-boundary-types`, knip.
Pattern: Pocock rules `default-exports`, `import-type`, `return-types`, `naming-conventions`.

### Layers

Packages form a chain, lowest first: `net`, `runtime`, `hamsterdan`, `hamsterdan-github`, `hamsterdan-cli`.
A package imports only packages below it, and only through their root.
`net` imports no Node builtin and no npm package. Code in `packages/*/src` takes time, timers and randomness from injected seams.

- Enforced by: dependency-cruiser (`.dependency-cruiser.cjs`); `no-restricted-properties` and `no-restricted-globals`; `net` has `"types": []`.

## Tests

- Test behaviour through the public functions. Replace slow or nondeterministic collaborators with typed fakes passed in;
  do not patch modules with `vi.mock`.
- Add a fast-check property next to the examples when a function has a rule that holds for all inputs.
  Stateful code gets a model-based test (`packages/net/test/model-property.ts`).
- The runtime gets crash-cut and scheduler properties (`packages/runtime/test/properties.ts`).
  A new store or a new step shape must keep both green.
- Coverage is a floor (statements, lines and functions 90%, branches 85%), not a goal. Every test asserts.
- Every quality gate has a planted defect in `fixtures/` and a gate test in `test/gates/`.
  Do not fix a fixture: it is supposed to fail.

## Readability

- Cyclomatic complexity at most 10 and nesting at most 4. Split the function when a check fails.
- Comments say why, or state an invariant the code cannot show. A JSDoc line on an exported name states its contract;
  api-extractor (`ae-undocumented`, in `pnpm lint:api`) fails a package root export without one.
- Biome formats the code: tabs, line width 120.
