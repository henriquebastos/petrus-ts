import type { Binding, Transition } from "./net.ts";
import type { Token } from "./token.ts";
import { tokenKey } from "./token.ts";

/**
 * Lists why `binding` is not a binding of `transition`: a variable with no value, a value for a name that is not
 * a variable, a value outside its variable's colour set, or a guard that is false. The guard runs only when the
 * values are right. An empty list means it is a binding.
 */
export function bindingProblems(transition: Transition, binding: Binding): readonly string[] {
	const problems = valueProblems(transition, binding);
	if (problems.length > 0 || transition.guard(binding)) {
		return problems;
	}
	return [`${transition.id}: the guard is false`];
}

function valueProblems(transition: Transition, binding: Binding): readonly string[] {
	const variables = Object.entries(transition.variables);
	const unbound = variables
		.filter(([variable]) => !Object.hasOwn(binding, variable))
		.map(([variable]) => `${transition.id}: variable ${variable} has no value`);
	const outside = variables
		.filter(
			([variable, colourSet]) => Object.hasOwn(binding, variable) && !colourSet.contains(valueOf(binding, variable)),
		)
		.map(
			([variable, colourSet]) =>
				`${transition.id}: ${variable} = ${tokenKey(valueOf(binding, variable))} is not in ${colourSet.name}`,
		);
	const unknown = Object.keys(binding)
		.filter((name) => !Object.hasOwn(transition.variables, name))
		.map((name) => `${transition.id}: ${name} is not a variable`);
	return [...unbound, ...outside, ...unknown];
}

/** The value the binding gives `variable`. Call it only for a variable that the binding has as an own key. */
export function valueOf(binding: Binding, variable: string): Token {
	return binding[variable] ?? null;
}
