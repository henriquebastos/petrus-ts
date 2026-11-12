import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import type { Recording, NetLayout } from "@petrus/net-view-model";
import { readRecording } from "@petrus/net-view-model";
import { layoutNet } from "@petrus/net-layout";
import { Viewer } from "@petrus/net-viewer-react";

type Load =
	| { readonly kind: "loading" }
	| { readonly kind: "ready"; readonly recording: Recording; readonly layout: NetLayout }
	| { readonly kind: "failed"; readonly message: string };

/** Loads one validated, display-only recording. A failed load never becomes an empty net. */
export function App({ request }: { readonly request: typeof fetch }): ReactElement {
	const [load, setLoad] = useState<Load>({ kind: "loading" });
	const [attempt, setAttempt] = useState(0);
	const [file, setFile] = useState("run.json");
	useEffect(() => {
		const controller = new AbortController();
		void request(`./${file}`, { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) throw new Error(`Recording request failed (${String(response.status)})`);
				const value: unknown = await response.json();
				const recording = readRecording(value);
				const layout = await layoutNet(recording);
				if (!controller.signal.aborted) setLoad({ kind: "ready", recording, layout });
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted) setLoad({ kind: "failed", message: String(error) });
			});
		return () => {
			controller.abort();
		};
	}, [attempt, request, file]);
	if (load.kind === "ready")
		return (
			<Viewer
				key={file}
				recording={load.recording}
				layout={load.layout}
				toolbar={
					<select
						aria-label="Example net"
						value={file}
						onChange={(event) => {
							setLoad({ kind: "loading" });
							setFile(event.target.value);
						}}
					>
						<option value="run.json">Producer & consumer</option>
						<option value="dining.json">Dining philosophers</option>
						<option value="pr-skip-b.json">PR review: skip B</option>
						<option value="pr-arrival-first.json">PR review: C arrives first</option>
						<option value="pr-selection-first.json">PR review: B selected first</option>
					</select>
				}
			/>
		);
	return (
		<main className="load-screen">
			<p className="eyebrow">PETRUS / NET VIEWER</p>
			<h1>{load.kind === "loading" ? "Loading the recorded run…" : "Cannot load this run"}</h1>
			{load.kind === "failed" && (
				<>
					<p role="alert">{load.message}</p>
					<button
						type="button"
						onClick={() => {
							setLoad({ kind: "loading" });
							setAttempt(attempt + 1);
						}}
					>
						Try again
					</button>
				</>
			)}
		</main>
	);
}
