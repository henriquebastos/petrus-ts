import type { ColourSet, Marking, Net, Place, Token } from "@petrus/petri-net";
import { placeId, transitionId } from "@petrus/petri-net";
import type { Handler, HandlerTransition } from "@petrus/runtime";

/**
 * Philosophers round a table with one fork between each two plates. Philosopher k eats with fork k on the left and
 * fork k + 1 (round the table) on the right, so neighbours share a fork and cannot eat at once. `eat` takes both
 * forks in one firing, so no philosopher holds one fork and waits for the other. The meal is the handler's work,
 * so the forks are held for the whole meal.
 */
const philosopher: ColourSet = {
	name: "Philosopher",
	contains: (token) => typeof token === "string" && /^p\d+$/.test(token),
};
const fork: ColourSet = { name: "Fork", contains: (token) => typeof token === "string" && /^f\d+$/.test(token) };

/** One token for each meal a philosopher still wants. */
export const hungry: Place = { id: placeId("hungry"), colourSet: philosopher };
export const forks: Place = { id: placeId("forks"), colourSet: fork };
/** One token for each meal eaten. */
export const fed: Place = { id: placeId("fed"), colourSet: philosopher };

/** The seat of a philosopher token, such as 2 for `p2`. */
export function seat(token: Token): number {
	return typeof token === "string" ? Number(token.slice(1)) : Number.NaN;
}

export function leftFork(seatNumber: number): string {
	return `f${String(seatNumber)}`;
}

function rightFork(seatNumber: number, size: number): string {
	return `f${String((seatNumber + 1) % size)}`;
}

/** The meal of one philosopher at a table of `size`. It holds both of that philosopher's forks. */
function eat(size: number): HandlerTransition<"philosopher" | "left" | "right"> {
	return {
		id: transitionId("eat"),
		variables: { philosopher, left: fork, right: fork },
		guard: ({ philosopher: diner, left, right }) =>
			left === leftFork(seat(diner)) && right === rightFork(seat(diner), size),
		inputs: [
			{ place: hungry, variables: ["philosopher"] },
			{ place: forks, variables: ["left", "right"] },
		],
		variants: {
			ate: {
				value: philosopher,
				outputs: [
					{ place: fed, expression: ({ philosopher: diner }) => [diner] },
					{ place: forks, expression: ({ left, right }) => [left, right] },
				],
			},
		},
	};
}

/** The net without its handler transition; the runtime adds it from `diningPhilosophersHandlers`. */
export const diningPhilosophers: Net = { places: [hungry, forks, fed], transitions: [] };

/** The meals still wanted, as philosopher tokens, and one fork between each two of `size` plates. */
export function initialMarking(size: number, meals: readonly Token[]): Marking {
	return { [hungry.id]: meals, [forks.id]: Array.from({ length: size }, (_, index) => leftFork(index)) };
}

/** The table outside the net. The operation id names the meal, so a second run of one operation is the same meal. */
export type Table = { readonly eat: (philosopher: Token, operationId: string) => Promise<void> };

export function diningPhilosophersHandlers(size: number, table: Table): readonly Handler[] {
	const meal: Handler<"philosopher" | "left" | "right"> = {
		transition: eat(size),
		run: async (binding, { operationId }) => {
			await table.eat(binding.philosopher, operationId);
			return { variant: "ate", value: binding.philosopher };
		},
	};
	return [meal];
}
