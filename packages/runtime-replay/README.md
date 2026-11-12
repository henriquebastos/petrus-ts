# 1 Runtime log replay

`replay` accepts the executable net and the full runtime log, starting before its first ingress.
For handler nets, pass the net from `withHandlers`. The runtime log names the expanded transitions.

Replay starts with an empty marking, adds each ingress, and calls Petrus `fire` for each occurrence.
Each frame contains the resulting marking and the enabled bindings from Petrus.
An unknown transition or invalid firing throws. The host compares the final frame with the committed marking.

Frames are occurrence positions, not committed snapshots. The log does not preserve concurrent step boundaries.
This adapter does not execute handlers or create Durable tasks. The runtime import contains types only.

Tests: `../../examples/classics/test/recording.test.ts`
"replay preserves duplicate token values and equal-count replacements" and
"replay rejects an unknown transition or a firing without its required tokens".
