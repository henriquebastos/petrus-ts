// Planted defect, appended to the real packages/petri-net/src/index.ts: one `export *` drags the storage adapter in.
// With native coordination, this reaches 16 petri-net files and 31 runtime files: one above each budget.
export * from "./storage.ts";
