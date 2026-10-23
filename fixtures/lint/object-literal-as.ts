// expect: @typescript-eslint/consistent-type-assertions @typescript-eslint/no-unsafe-type-assertion
import type { Arc } from "./shared.ts";

export const arc = { place: "inbox" } as Arc;
