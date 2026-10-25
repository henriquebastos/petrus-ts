import type { ColourSet, Marking, Net, Place, Token } from "@petrus/petri-net";
import { placeId, transitionId } from "@petrus/petri-net";
import type { Handler, HandlerTransition } from "@petrus/runtime";

/**
 * Philosophers round a table with one fork between each two plates. Philosopher k eats with fork k on the left and
 * fork k + 1 (round the table) on the right, so neighbours share a fork and cannot eat at once. `eat` takes both
 * forks in one firing, so no philosopher holds one fork and waits for the other. Its arc from `forks` computes the
 * two forks from the philosopher, so a binding chooses only the philosopher. The meal is the handler's work, so the
 * forks are held for the whole meal.
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

/** The two forks of a philosopher at a table of `size`: the left one, then the right one. */
function forksOf(diner: Token, size: number): readonly Token[] {
	return [leftFork(seat(diner)), rightFork(seat(diner), size)];
}

/** The meal of one philosopher at a table of `size`. It holds both of that philosopher's forks. */
function eat(size: number): HandlerTransition<"philosopher"> {
	return {
		id: transitionId("eat"),
		variables: { philosopher },
		guard: () => true,
		inputs: [
			{ place: hungry, variables: ["philosopher"] },
			{ place: forks, expression: ({ philosopher: diner }) => forksOf(diner, size) },
		],
		variants: {
			ate: {
				value: philosopher,
				outputs: [
					{ place: fed, expression: ({ philosopher: diner }) => [diner] },
					{ place: forks, expression: ({ philosopher: diner }) => forksOf(diner, size) },
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
	const meal: Handler<"philosopher"> = {
		transition: eat(size),
		run: async (binding, { operationId }) => {
			await table.eat(binding.philosopher, operationId);
			return { variant: "ate", value: binding.philosopher };
		},
	};
	return [meal];
}
