// Planted defect, appended to the real packages/net/src/index.ts: one `export *` drags the storage adapter in.
export * from "./storage.ts";
