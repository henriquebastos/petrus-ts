import fc from "fast-check";

// @fast-check/vitest puts the seed in each `test.prop` name. Stryker selects the tests of a mutant
// by name, and incremental mode matches tests by name, so every Stryker run must use one seed.
fc.configureGlobal({ seed: 20_261_022 });
