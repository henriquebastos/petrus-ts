// Planted defect, appended to the real packages/petri-net/src/index.ts: one `export *` drags the storage adapter in.
// The indexed engine reaches 16 petri-net files and 27 runtime files here: one above each budget.
export * from "./storage.ts";
