# 1 Recorded net viewer

The host shows producer-consumer and dining-philosopher recordings through the same viewer packages.
It supports pan, zoom, node selection, token inspection, and history navigation. It cannot change or fire the net.
The viewer follows the system color preference, including changes while the page is open.

From the repository root:

```sh
pnpm --filter @petrus/example-classics build
pnpm --filter @petrus/example-classics serve --port 5300 --strictPort
```

The build runs `../src/main.ts`. The recorder uses the real Petrus TS runtime and Pi Durable memory storage.
A local workshop returns `item n` for `order n`. No external service or language model runs.
The build writes the recording, then bundles the browser app. Rebuild to record changed net code.

`../src/record-run.ts` uses the expanded `runtime.net`, runs native executions, and reads
the committed state. `../../../packages/runtime-replay/src/replay.ts` applies each ingress and calls Petrus `fire` for each occurrence.
The recorder rejects a replay whose final marking differs from the committed marking.
The recording includes a SHA-256 digest of the local package sources and classical-net sources.

Test: `../test/recording.test.ts` "records real handler runs with conserved slots and the committed final tokens".

## 1a Inspection preserves coloured tokens

The producer-consumer graph has eight places, four transitions, and twelve arcs. The busy places hold handler bindings.
The result places receive handler results. Select a node on the canvas or through the inspector's selector.
Place inspection shows every token value, including duplicates. Transition inspection shows enabled bindings
computed by Petrus TS. Enabled binding elements can compete for the same tokens.

`../../../packages/net-view-model/src/model.ts` defines the display contract. TypeBox validates downloaded recordings before the app displays them.
Node IDs distinguish places from transitions. Arc IDs preserve parallel arcs.
Guards and arc expressions remain functions in the net. The viewer does not parse or execute their descriptions.

Tests: `../test/recording.test.ts` "replay preserves duplicate token values and equal-count replacements" and
"projection preserves parallel arcs and separates place IDs from transition IDs".
Test: `../test/viewer.test.tsx` "navigates both history boundaries and preserves duplicate and changed token values".

## 1b Replay is not live execution

Each position shows the marking after one log entry. These intermediate markings are not all committed snapshots.
Enqueue records admission before execution. A busy token remains held through execution and owned children until terminal settlement.
The log does not retain Jensen step boundaries. Equal timestamps do not identify concurrent steps.
The clock records logical ticks, not elapsed milliseconds. The browser only reads the recording.

The initial position shows the first ingress. The first-frame button shows the empty instance before that ingress.
The final frame contains three used items and two free slots. Reload returns to the first ingress.
ELK supplies automatic node placement and arc routes through the separate layout package.
The package accepts other valid Petrus nets. The example selector offers two recorded nets.
File import and editing are not supported yet. Forward animation illustrates arc flow, not runtime duration.

## 1c Repeat the browser proof

With `agent-browser` installed, pass the running viewer URL:

The orb supplies this executable. `knip.json` permits that external binary only for the classical example.

```sh
pnpm --filter @petrus/example-classics verify:viewer http://localhost:5300
```

`../verify-viewer.ts` uses the browser controls at all 37 positions across both recordings. It checks node counts, arcs, enabled
transitions, inspected token values, final items, and reload against the served recording.
The recorder tests exercise real Durable tasks. The UI tests use jsdom without layout.
Browser inspection is still required for layout and pointer behavior.

Test: `../test/viewer.test.tsx` "loads a validated recording after a failed request and an explicit retry".
Test: `../test/viewer.test.tsx` "rejects an invalid recording rather than showing an empty net".
