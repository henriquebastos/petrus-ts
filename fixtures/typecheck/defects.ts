// Planted defects, one per compiler flag. A line with an error ends with "// <codes> <flag>": the codes tsc must report there.
import { Shape } from "./shapes.ts"; // TS1484 verbatimModuleSyntax: a type must be imported with `import type`.

type Options = { readonly timeoutMs?: number };
export const options: Options = { timeoutMs: undefined }; // TS2375 exactOptionalPropertyTypes: absent is not undefined.

export function firstWeight(weights: readonly { readonly weight: number }[]): number {
	const first = weights[0];
	return first.weight; // TS18048 noUncheckedIndexedAccess: an index read can miss.
}

export const doubled = [1, 2].map((weight) => weight * 2); // TS9010 isolatedDeclarations: exported values need a written type.

export function area(shape): number { // TS7006 TS9011 strict and isolatedDeclarations: every parameter needs a type.
	return shape.sides;
}

export enum Colour { Red } // TS1294 erasableSyntaxOnly: an enum is not erasable syntax.

export class Base {
	describe(): string {
		return "base";
	}
}

export class Derived extends Base {
	describe(): string { // TS4114 noImplicitOverride: a replaced method must say `override`.
		return "derived";
	}
}

export function sign(value: number): number | undefined { // TS7030 noImplicitReturns: every path must return.
	if (value > 0) {
		return 1;
	}
}

export function label(sides: number): string {
	let name = "shape";
	switch (sides) {
		case 3: // TS7029 noFallthroughCasesInSwitch: a non-empty case must not fall through.
			name = "triangle";
		case 4:
			name = "square";
	}
	return name;
}

export function unusedLocal(): number {
	const spare = 1; // TS6133 noUnusedLocals
	return 0;
}

export function unusedParameter(spare: number): number { // TS6133 noUnusedParameters
	return 0;
}

export const exitCode: number = process.exitCode; // TS2591 types: [] keeps Node globals out of the packages.

export const shape: Shape = { sides: 3 };
