# 1 Display data for Petrus

`src/index.ts` exports the display contract. `projectNet` converts a Petrus net into nodes and directed arcs.
Place IDs and transition IDs have separate prefixes. Parallel arcs keep separate IDs.
`inspectMarking` asks Petrus for enabled bindings. It does not fire a transition.
`viewTokens` preserves token values and multiplicity, including places with prototype names.

`Recording` contains topology and one or more display frames. A static net needs one initial frame.
`readRecording` validates the shape of untrusted data with TypeBox. It does not verify execution history.
The host must create topology from a valid net and provide JSON-compatible tokens for serialized recordings.
Guards and arc expressions remain in Petrus. They are not display strings that the viewer can execute.

`NetLayout` is separate data: node positions, directed point lists for arc routes, and arc-label positions.
It contains no React objects. A host can supply saved layout data or call a layout package.

Tests: `test/model.test.ts` "displays an empty net and treats prototype names as token keys".
`../../examples/classics/test/recording.test.ts` "projection preserves parallel arcs and separates place IDs from transition IDs".
