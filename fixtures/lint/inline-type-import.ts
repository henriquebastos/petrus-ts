// expect: @typescript-eslint/no-import-type-side-effects no-restricted-syntax
import { type Arc } from "./shared.ts";

export const weightOf = (arc: Arc): number => arc.weight;
