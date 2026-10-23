// expect: @typescript-eslint/no-unsafe-type-assertion
type PullRequestEvent = { readonly action: string; readonly number: number };

export function parseEvent(body: string): PullRequestEvent {
	return JSON.parse(body) as PullRequestEvent;
}
