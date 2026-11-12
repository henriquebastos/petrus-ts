// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test } from "vitest";
import type { Recording } from "@petrus/net-view-model";
import { App } from "../viewer/app.tsx";
import { Viewer } from "@petrus/net-viewer-react";

beforeAll(() => {
	// jsdom has no layout. The browser proof checks measured nodes, edges and viewport controls.
	globalThis.ResizeObserver = class {
		observe(): undefined {
			return undefined;
		}
		unobserve(): undefined {
			return undefined;
		}
		disconnect(): undefined {
			return undefined;
		}
	};
});
afterEach(cleanup);

const recording: Recording = {
	format: "petrus-recording-1",
	source: "UI fixture",
	title: "Producer & consumer",
	nodes: [
		{ id: "place:orders", name: "orders", kind: "place", detail: "Order" },
		{ id: "place:free", name: "free", kind: "place", detail: "Slot" },
		{ id: "transition:produce", name: "produce", kind: "transition", detail: "order, slot" },
	],
	arcs: [
		{ id: "order", source: "place:orders", target: "transition:produce", label: "order" },
		{ id: "slot", source: "place:free", target: "transition:produce", label: "slot" },
	],
	frames: [
		{ kind: "initial", label: "Empty instance", at: null, binding: {}, marking: {}, enabled: [] },
		{
			kind: "ingress",
			label: "initial-orders",
			at: 0,
			binding: {},
			marking: { orders: ["first", "first"], free: ["slot", "slot"] },
			enabled: [{ transition: "produce", binding: { order: "first", slot: "slot" } }],
		},
		{
			kind: "occurrence",
			label: "produce",
			at: 1,
			binding: { order: "first" },
			marking: { orders: ["first", { next: "second" }], free: ["slot"] },
			enabled: [],
		},
	],
	committedMarking: { orders: ["first", { next: "second" }], free: ["slot"] },
};

test("navigates both history boundaries and preserves duplicate and changed token values", () => {
	render(
		<Viewer
			recording={recording}
			layout={{
				positions: Object.fromEntries(recording.nodes.map((node, i) => [node.id, { x: i * 100, y: 0 }])),
				routes: {},
				labels: {},
			}}
		/>,
	);
	expect(within(screen.getByRole("list", { name: "Token values" })).getAllByText('"first"')).toHaveLength(2);
	fireEvent.click(screen.getByRole("button", { name: "Next event" }));
	expect(within(screen.getByRole("list", { name: "Token values" })).getByText(/"next": "second"/)).toBeDefined();
	expect(screen.getByRole("button", { name: "Next event" })).toHaveProperty("disabled", true);
	fireEvent.click(screen.getByRole("button", { name: "Previous event" }));
	expect(within(screen.getByRole("list", { name: "Token values" })).queryByText(/"next": "second"/)).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "First frame" }));
	expect(screen.getByText("This place has no tokens.")).toBeDefined();
	expect(screen.getByRole("button", { name: "Previous event" })).toHaveProperty("disabled", true);
	fireEvent.click(screen.getByRole("button", { name: "Final frame" }));
	expect(screen.getByRole("button", { name: "Final frame" })).toHaveProperty("disabled", true);
	fireEvent.change(screen.getByLabelText("Replay position"), { target: { value: "1" } });
	fireEvent.change(screen.getByLabelText("Selected node"), { target: { value: "transition:produce" } });
	expect(screen.getByText("Enabled bindings")).toBeDefined();
	expect(screen.getByText(/"slot": "slot"/)).toBeDefined();
	fireEvent.change(screen.getByLabelText("Selected node"), { target: { value: "place:free" } });
	expect(within(screen.getByRole("list", { name: "Token values" })).getAllByText('"slot"')).toHaveLength(2);
	const orders = document.querySelector('[data-id="place:orders"]');
	if (orders === null) throw new Error("The orders node was not rendered");
	fireEvent.click(orders);
	expect(screen.getByRole("heading", { name: "orders" })).toBeDefined();
});

test("loads a validated recording after a failed request and an explicit retry", async () => {
	let attempts = 0;
	const request: typeof fetch = () =>
		Promise.resolve(++attempts === 1 ? new Response("unavailable", { status: 503 }) : Response.json(recording));
	render(<App request={request} />);
	expect(screen.getByText("Loading the recorded run…")).toBeDefined();
	expect((await screen.findByRole("alert")).textContent).toContain("503");
	fireEvent.click(screen.getByRole("button", { name: "Try again" }));
	expect(await screen.findByRole("heading", { name: "Producer & consumer" })).toBeDefined();
	fireEvent.change(screen.getByLabelText("Example net"), { target: { value: "dining.json" } });
	expect(await screen.findByRole("heading", { name: "Producer & consumer" })).toBeDefined();
	expect(attempts).toBe(3);
});

test("rejects an invalid recording rather than showing an empty net", async () => {
	render(<App request={() => Promise.resolve(Response.json({ frames: [] }))} />);
	expect((await screen.findByRole("alert")).textContent).toContain("invalid format");
	expect(screen.queryByLabelText("Replay position")).toBeNull();
});

test("an aborted request cannot replace a newer recording with its error", async () => {
	const pending = Promise.withResolvers<Response>();
	const { rerender } = render(<App request={() => pending.promise} />);
	rerender(<App request={() => Promise.resolve(Response.json(recording))} />);
	expect(await screen.findByRole("heading", { name: recording.title })).toBeDefined();
	await act(async () => {
		pending.reject(new Error("stale request"));
		await Promise.resolve();
	});
	expect(screen.queryByRole("alert")).toBeNull();
	expect(screen.getByRole("heading", { name: recording.title })).toBeDefined();
});
