// Planted defect: an example imports a package's src file instead of the package root.
import { internal } from "../../../packages/runtime/src/internal.ts";

export const deep = internal;
