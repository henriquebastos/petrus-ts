import type { ReactElement, ReactNode } from "react";
import { useState } from "react";
import type { Recording, NetLayout } from "@petrus/net-view-model";
import { NetCanvas } from "./graph.tsx";
import { Inspector } from "./inspector.tsx";

/** Navigates a recorded run without changing any execution state. */
export function Viewer({
	recording,
	layout,
	toolbar,
}: {
	readonly recording: Recording;
	readonly layout: NetLayout;
	readonly toolbar?: ReactNode;
}): ReactElement {
	const [position, setPosition] = useState({ cursor: Math.min(1, recording.frames.length - 1), pulse: 0 });
	const { cursor, pulse } = position;
	function setCursor(next: number): void {
		setPosition({ cursor: next, pulse: next === cursor + 1 ? pulse + 1 : 0 });
	}
	const [selected, setSelected] = useState(recording.nodes[0]?.id ?? "");
	const frame = recording.frames[cursor];
	if (frame === undefined) throw new Error("The replay cursor is outside the recording");
	return (
		<main className="viewer">
			<header className="topbar">
				<span className="brand">petrus</span>
				<h1>{recording.title}</h1>
				<span className="status">Read only</span>
				{toolbar}
			</header>
			<div className="workspace">
				<section className="canvas-panel" aria-label="Net canvas">
					<div className="canvas-heading">
						<span>
							Executable net{" "}
							<small>
								{recording.nodes.length} nodes · {recording.arcs.length} arcs
							</small>
						</span>
						<span className="legend">
							<i /> enabled <b /> last occurrence
						</span>
					</div>
					<div className="canvas">
						<NetCanvas
							recording={recording}
							layout={layout}
							frame={frame}
							pulse={pulse}
							selected={selected}
							onSelect={setSelected}
						/>
					</div>
				</section>
				<Inspector recording={recording} frame={frame} selected={selected} onSelect={setSelected} />
			</div>
			<nav className="event-strip" aria-label="Event timeline">
				<span className="eyebrow">EVENTS</span>
				<div className="event-track">
					{recording.frames.map((entry, index) => (
						<button
							key={index}
							type="button"
							className="event-tick"
							data-kind={entry.kind}
							aria-current={index === cursor ? "step" : undefined}
							aria-label={`Go to event ${String(index)}: ${entry.label}`}
							title={`${String(index)} · ${entry.kind} · ${entry.label}`}
							onClick={() => {
								setCursor(index);
							}}
						>
							<i />
							<span>{index}</span>
						</button>
					))}
				</div>
			</nav>
			<section className="timeline" aria-label="Replay navigation">
				<div className="transport">
					<button
						type="button"
						aria-label="First frame"
						disabled={cursor === 0}
						onClick={() => {
							setCursor(0);
						}}
					>
						⏮
					</button>
					<button
						type="button"
						aria-label="Previous event"
						disabled={cursor === 0}
						onClick={() => {
							setCursor(cursor - 1);
						}}
					>
						←
					</button>
					<output aria-live="polite">
						{cursor} / {recording.frames.length - 1}
					</output>
					<button
						type="button"
						aria-label="Next event"
						disabled={cursor === recording.frames.length - 1}
						onClick={() => {
							setCursor(cursor + 1);
						}}
					>
						→
					</button>
					<button
						type="button"
						aria-label="Final frame"
						disabled={cursor === recording.frames.length - 1}
						onClick={() => {
							setCursor(recording.frames.length - 1);
						}}
					>
						⏭
					</button>
				</div>
				<label htmlFor="event-choice">Replay position</label>
				<select
					id="event-choice"
					value={cursor}
					onChange={(event) => {
						setCursor(Number(event.target.value));
					}}
				>
					{recording.frames.map((entry, index) => (
						<option key={index} value={index}>
							{index} · {entry.kind} · {entry.label}
						</option>
					))}
				</select>
			</section>
			<footer className="statusbar">
				<span>
					{frame.kind} · {frame.label}
				</span>
				<span>Recorded positions · not elapsed time</span>
			</footer>
		</main>
	);
}
