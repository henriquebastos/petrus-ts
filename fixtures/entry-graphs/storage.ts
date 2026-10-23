// Planted defect: a storage adapter that loads node:sqlite. It must never be reachable from the petri-net root.
import { DatabaseSync } from "node:sqlite";

export function openStore(path: string): DatabaseSync {
	return new DatabaseSync(path);
}
