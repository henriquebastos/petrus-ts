// expect: @typescript-eslint/no-floating-promises
type Store = { readonly commit: (value: number) => Promise<void> };

export function save(store: Store): void {
	store.commit(1);
}
