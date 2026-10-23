// Planted defect, appended to the real packages/petri-net/src/index.ts: one `export *` drags the storage adapter in.
export * from "./storage.ts";
