# 1 React display components

`NetCanvas`, `Inspector`, and `Viewer` consume the display types from `../net-view/src/index.ts`.
The canvas needs topology, layout, a frame, and selection callbacks. The inspector needs the selected node and frame.
`Viewer` composes these components with a compact header, event strip, and back and forward controls.
Its optional toolbar slot lets the host add controls without changing the viewer.

The host supplies layout. This package has no ELK, runtime replay, or Durable dependency.
Mount a new viewer with a different React key when changing the recording or topology.
The example host in `../../examples/classics/viewer/app.tsx` uses the same viewer for both classical nets.

Load React Flow's stylesheet, then the public `@petrus/net-view-react/style.css` export.
The default stylesheet includes document-level theme and reset rules for the full-page viewer.
It follows the system light or dark preference. Hosts can instead provide their own styles.

Adjacent forward occurrences animate input arcs, then output arcs. Backward moves and jumps do not animate execution.
The dots indicate arc flow, not token multiplicity or elapsed runtime. Reduced-motion preference disables them.
The displayed marking is the selected frame, not a temporary animation state.

The viewer cannot fire transitions, edit topology, save layout, or import files.
`../../examples/classics/verify-viewer.ts` checks the built app in Chromium.
Test: `../../examples/classics/test/viewer.test.tsx`
"navigates both history boundaries and preserves duplicate and changed token values".
