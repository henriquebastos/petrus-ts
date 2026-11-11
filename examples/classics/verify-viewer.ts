import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { parseJson } from "../../scripts/json.ts";
import { readRecording } from "@petrus/net-view";
import type { Recording, ViewFrame, ViewNode } from "@petrus/net-view";

const url = process.argv[2];
if (url === undefined) throw new Error("Pass the running viewer URL");
const response = await fetch(new URL("run.json", url));
assert.equal(response.status, 200);
const recording = readRecording(await response.json());
assert.deepEqual(
	recording,
	readRecording(JSON.parse(await readFile(new URL("viewer/public/run.json", import.meta.url), "utf8"))),
);
assert.deepEqual(recording.committedMarking, { used: ["item 1", "item 2", "item 3"], free: ["slot", "slot"] });
assert.equal(recording.frames.length, 20);

const dining = readRecording(await (await fetch(new URL("dining.json", url))).json());
assert.deepEqual(
	dining,
	readRecording(JSON.parse(await readFile(new URL("viewer/public/dining.json", import.meta.url), "utf8"))),
);
assert.deepEqual(dining.committedMarking.fed?.slice().sort(), ["p0", "p1", "p2", "p3", "p4"]);
assert.deepEqual(dining.committedMarking.forks?.slice().sort(), ["f0", "f1", "f2", "f3", "f4"]);

const session = `proof-${String(process.pid)}`;
function browser(...args: string[]): string {
	return execFileSync("agent-browser", ["--session", session, ...args], { encoding: "utf8", timeout: 30_000 });
}

const observation = Type.Object({
	success: Type.Literal(true),
	data: Type.Object({
		result: Type.Object({
			nodes: Type.Record(Type.String(), Type.String()),
			enabled: Type.Array(Type.String()),
			tokens: Type.Array(Type.Unknown()),
			edges: Type.Integer(),
			cursor: Type.String(),
		}),
	}),
});

const inspect = `({
 nodes: Object.fromEntries([...document.querySelectorAll('.react-flow__node')].map(n => [n.dataset.id, n.querySelector('.shape').textContent])),
 enabled: [...document.querySelectorAll('.transition[data-enabled="true"] .node-name')].map(n => n.textContent),
 tokens: [...document.querySelectorAll('.tokens pre')].map(n => JSON.parse(n.textContent)),
 edges: document.querySelectorAll('.react-flow__edge').length,
 cursor: document.querySelector('output').textContent
})`;

function assertPlaceCounts(
	nodes: readonly ViewNode[],
	frame: ViewFrame,
	displayed: Readonly<Record<string, string>>,
): void {
	for (const node of nodes.filter(({ kind }) => kind === "place")) {
		assert.equal(displayed[node.id], String(frame.marking[node.name]?.length ?? 0), node.name);
	}
}

function verifyFrames(run: Recording, defaultPlace: string): void {
	for (const [index, frame] of run.frames.entries()) {
		browser("select", "#event-choice", String(index));
		const place = Object.keys(frame.marking).find((id) => id.includes(":busy")) ?? defaultPlace;
		browser("select", "#node-choice", `place:${place}`);
		const {
			data: { result },
		} = parseJson(browser("eval", "--json", inspect), observation);
		assert.equal(result.cursor, `${String(index)} / ${String(run.frames.length - 1)}`);
		assert.equal(Object.keys(result.nodes).length, run.nodes.length);
		assert.equal(result.edges, run.arcs.length);
		assertPlaceCounts(run.nodes, frame, result.nodes);
		assert.deepEqual(new Set(result.enabled), new Set(frame.enabled.map(({ transition }) => transition)));
		assert.deepEqual(result.tokens, frame.marking[place] ?? []);
	}
}

try {
	browser("open", url);
	browser("set", "viewport", "1440", "1050", "2");
	browser("set", "media", "light");
	browser("wait", "--text", "Producer & consumer");
	browser("wait", "--fn", "document.querySelectorAll('.react-flow__edge').length === 12");
	verifyFrames(recording, "free");
	browser("click", '[aria-label="First frame"]');
	browser("click", '[aria-label="Final frame"]');
	browser("select", "#node-choice", "place:used");
	const final = parseJson(browser("eval", "--json", inspect), observation).data.result;
	assert.deepEqual(final.tokens, ["item 1", "item 2", "item 3"]);
	browser("reload");
	browser("wait", "--text", "Producer & consumer");
	assert.equal(parseJson(browser("eval", "--json", inspect), observation).data.result.cursor, "1 / 19");
	const colors = ["body", ".inspector", ".tokens li", ".react-flow__controls-button"].map(
		(selector) => `getComputedStyle(document.querySelector('${selector}')).backgroundColor`,
	);
	const light = colors.map((query) => browser("eval", query));
	const beforeTheme = parseJson(browser("eval", "--json", inspect), observation).data.result;
	browser("set", "media", "dark");
	browser("wait", ".react-flow.dark");
	for (const [index, query] of colors.entries()) assert.notEqual(browser("eval", query), light[index], query);
	assert.deepEqual(parseJson(browser("eval", "--json", inspect), observation).data.result, beforeTheme);
	browser("set", "media", "light");
	browser("wait", ".react-flow.light");
	assert.deepEqual(
		colors.map((query) => browser("eval", query)),
		light,
	);
	console.log(
		"PASS: 20 replay positions, 12 nodes, 12 arcs, all place counts, enabled transitions, inspected token values, final items, and reload.",
	);
	console.log("PASS: system theme changes update colors without changing the replay or selected tokens.");
	console.log(recording.source);
	browser("select", '[aria-label="Example net"]', "dining.json");
	browser("wait", "--text", "Dining philosophers");
	browser("wait", "--fn", `document.querySelectorAll('.react-flow__edge').length === ${String(dining.arcs.length)}`);
	verifyFrames(dining, "fed");
	console.log(
		`PASS: the same viewer renders all ${String(dining.frames.length)} dining positions, ${String(dining.nodes.length)} nodes, and ${String(dining.arcs.length)} arcs. All philosophers finish and all forks return.`,
	);
	browser("select", '[aria-label="Example net"]', "run.json");
	browser("wait", "--text", "Producer & consumer");
	assert.equal(parseJson(browser("eval", "--json", inspect), observation).data.result.cursor, "1 / 19");
	console.log(
		"PASS: switching nets resets selection and replay. Both served recordings match the local runtime output.",
	);
} finally {
	browser("close");
}
