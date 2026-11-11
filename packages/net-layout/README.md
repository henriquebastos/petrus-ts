# 1 Automatic layout

`layoutNet` accepts a display graph and returns node positions, directed arc routes, and arc-label positions.
It uses ELK's layered algorithm with a fixed seed. It handles cycles, parallel arcs, and disconnected nodes.
The graph stays unchanged. This package has no React or runtime dependency.

The default shapes are 44-unit places and 16-by-44-unit transitions. Labels appear below the shapes.
These sizes match the default React renderer. A host with other shapes can supply its own layout instead.

Test: `test/layout.test.ts` "lays out arbitrary names, cycles, parallel arcs, and isolated nodes without changing topology".
