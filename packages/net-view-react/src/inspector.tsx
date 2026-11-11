import type { ReactElement } from "react";
import type { ViewFrame, Recording } from "@petrus/net-view";
import { viewTokens } from "@petrus/net-view";

/** Shows complete token values, including duplicate values, at the replay cursor. */
export function Inspector({
	recording,
	frame,
	selected,
	onSelect,
}: {
	readonly recording: Recording;
	readonly frame: ViewFrame;
	readonly selected: string;
	readonly onSelect: (id: string) => void;
}): ReactElement {
	const node = recording.nodes.find(({ id }) => id === selected);
	return (
		<aside className="inspector" aria-label="Node inspector">
			<p className="eyebrow">INSPECTOR</p>
			<label htmlFor="node-choice">Selected node</label>
			<select
				id="node-choice"
				value={selected}
				onChange={(event) => {
					onSelect(event.target.value);
				}}
			>
				{recording.nodes.map((entry) => (
					<option key={entry.id} value={entry.id}>
						{entry.name} · {entry.kind}
					</option>
				))}
			</select>
			{node && <NodeDetails node={node} frame={frame} />}
			<div className="event-detail">
				<h3>Current event</h3>
				<p className="event-kind">{frame.kind}</p>
				<strong>{frame.label}</strong>
				<p className="muted">Logical time: {frame.at ?? "not started"}</p>
				<pre aria-label="Event binding">{JSON.stringify(frame.binding, null, 2)}</pre>
			</div>
			<details className="provenance">
				<summary>About this recording</summary>
				<p className="muted">
					The host supplies the marking and enabled bindings. A replay position does not identify a concurrent step
					or commit boundary.
				</p>
				<code>{recording.source}</code>
				<pre aria-label="Committed final marking">{JSON.stringify(recording.committedMarking, null, 2)}</pre>
			</details>
		</aside>
	);
}

function NodeDetails({
	node,
	frame,
}: {
	readonly node: Recording["nodes"][number];
	readonly frame: ViewFrame;
}): ReactElement {
	return (
		<>
			<h2>{node.name}</h2>
			<p className="muted">
				{node.kind === "place" ? "Colour set" : "Variables"}: {node.detail || "none"}
			</p>
			{node.kind === "place" ? (
				<TokenList tokens={viewTokens(frame.marking, node.name)} />
			) : (
				<>
					<h3>Enabled bindings</h3>
					<p className="muted">
						Computed by Petrus TS at this replay position. Enabled does not mean selected to fire.
					</p>
					<pre>
						{JSON.stringify(
							frame.enabled.filter(({ transition }) => transition === node.name).map(({ binding }) => binding),
							null,
							2,
						)}
					</pre>
					<p className="muted">Guards and arc expressions remain executable TypeScript.</p>
				</>
			)}
		</>
	);
}

function TokenList({ tokens }: { readonly tokens: readonly unknown[] }): ReactElement {
	return (
		<>
			<h3>
				Tokens <span className="count">{tokens.length}</span>
			</h3>
			{tokens.length === 0 ? (
				<p className="empty">This place has no tokens.</p>
			) : (
				<ol className="tokens" aria-label="Token values">
					{tokens.map((token, index) => (
						<li key={index}>
							<pre>{JSON.stringify(token, null, 2)}</pre>
						</li>
					))}
				</ol>
			)}
		</>
	);
}
