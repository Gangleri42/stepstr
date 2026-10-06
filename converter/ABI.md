# Converter ABI, version 2

`converter.wasm` is a standalone WebAssembly module (no Emscripten JavaScript) that reads a STEP file and produces
the assembly tree, one mesh per solid and the exact geometry of every face, edge and vertex. `loader.js`
instantiates it in a page, a Worker, a sandboxed napplet or Node. The bytes come from the caller; the module and
its loader never fetch, evaluate strings or touch storage.

## Imports

Only these, all implemented by `loader.js`:

- `wasi_snapshot_preview1`: `fd_write`, `fd_close`, `fd_seek`, `fd_read`, `environ_sizes_get`, `environ_get`,
  `clock_time_get` (id 0 is the wall clock in Unix time; OpenCascade rejects dates before 1979), `random_get`,
  `proc_exit`.
- `env.emscripten_notify_memory_growth`.
- `env.conv_progress(phase: i32, done: f64, total: f64) -> i32`: the progress of the long calls, and the host's
  answer, `0` to continue or `1` to stop the call. See below.

Any other import is a build error.

### Progress and stopping

`conv_read`, `conv_transfer`, `conv_mesh` and `conv_geometry` report through `conv_progress`. Phases: 1 read,
2 transfer, 3 mesh, 4 geometry. `done / total` is the phase's progress as a fraction, rising from 0 to 1 within
one call (this module sends `total` 1 throughout):

- read: 0 at the start, 1 at the end and nothing between, since the STEP parser takes no progress range.
- transfer: OpenCascade's own position over the first 90%, the translation and healing of the shapes root by root
  (the document's names and colours come at the end of that, without reports); then the walk that builds the tree,
  one report per part visited.
- mesh: BRepMesh's own position over the first 90% (it reports face by face, after the edges are discretised);
  then the normals, one report per face.
- geometry: records written over records to write.

Every call reports its start and its end, and between them at most every 5 milliseconds, so a short call reports
twice (a `conv_geometry` over the face limit too, before it answers `null`). A report is a call into the host on
the module's stack. The loader may implement the import as a plain function or, when the caller wrapped the export
with `WebAssembly.promising` (JSPI), as a `WebAssembly.Suspending` function that yields to the event loop; while a
JSPI call is suspended the module must not be entered again. An exception must not cross the import into the
module: `loader.js` catches a listener's exception and answers stop instead.

A stop answer makes the call return `-5` as soon as the running loop sees it. OpenCascade's algorithms see it
through `Message_ProgressIndicator::UserBreak`, which their loops poll between roots, parts, faces, healing steps
and meshing passes; a poll also sends a report when the throttle allows, so a stop lands at the next poll, not
only at the next advance. A stop to the start report ends the call before its work; one to the end report comes
too late, and the call succeeds.

A stop inside `conv_transfer` returns within tens of milliseconds, mostly spent freeing the parsed file; one inside
`conv_mesh` within a few once BRepMesh reports, and one inside `conv_geometry` at once. Some work never polls: a
healing step on a large B-spline face, which can take over a second; reading the document's names and colours at
the end of the translation; and BRepMesh's discretisation of the edges and first triangulation of a face, which on
a large free-form solid can take seconds before its first report.

A stopped call leaves the module ready for the next. A stopped `conv_read` has freed the bytes, and a stopped
`conv_transfer` has dropped the parsed file and the half-built document; both start again at `conv_alloc`, and
`conv_close` works. A stopped `conv_mesh` has dropped the solid's half-built triangulation, so the next `conv_mesh`
of it meshes from scratch and gives the same bytes as a fresh one. A stopped `conv_geometry` leaves nothing
behind.

## Memory and results

Pointers are `u32` offsets into the module's memory; read them with `>>> 0`, since the heap may pass 2 GB. A call
that produces data writes it to one converter-owned buffer and returns its length, or a negative error code;
`conv_result_ptr()` gives the buffer's address, valid until the next `conv_*` call. Memory can grow during any
call, so take views on `memory.buffer` after the call returns. A result past 2 GB is refused (`-4`); `conv_mesh`
refuses it before writing anything.

An error is a negative return, with `conv_error()` pointing at a NUL-terminated UTF-8 message: `-1` bad input
(also a call out of sequence, an unknown solid, a deflection that is not positive), `-2` OpenCascade failure, `-3`
out of memory, `-4` anything else, `-5` cancelled by the host's stop answer (message `cancelled during <phase>`).
After an error the module stays usable for the next file; after a WebAssembly trap it must be discarded
(OpenCascade is not hardened against every malformed entity), and `loader.js` starts a fresh instance from the
compiled module at the next open.

## Calls

| Export | Returns | |
| --- | --- | --- |
| `conv_abi()` | `2` | this document's version |
| `conv_set_option(key: i32, value: f64)` | `0` or `-1` | at any time; see below |
| `conv_alloc(size: u32)` | `ptr` | a buffer for the STEP bytes, owned by the converter; `0` if it cannot be allocated |
| `conv_read()` | `0` / error | parses the bytes placed at `conv_alloc`'s buffer and frees them |
| `conv_transfer()` | solid count / error | builds the shapes and the assembly tree; drops the parsed file |
| `conv_tree()` | length / error | the tree as JSON (UTF-8) |
| `conv_mesh(solid: i32, linear: f64, angular: f64)` | length / error | meshes one solid, binary layout below |
| `conv_geometry(solid: i32)` | length / error | one solid's exact geometry as JSON, or `null` |
| `conv_warnings()` | length / error | warnings since the last `conv_warnings`, as a JSON array of strings; clears them |
| `conv_release(solid: i32)` | `0` / error | drops the solid's triangulation |
| `conv_close()` | `0` | drops the document; the next file starts with `conv_alloc` |
| `conv_result_ptr()` | `ptr` | the last result |
| `conv_error()` | `ptr` | the last error message |

A solid is a body of a part: a solid, else a shell, else a loose face. The oracle's `solids_of` stops at shells, so
a part made of loose faces alone has bodies here and none there; the parity tests have no such part. Instances
share their prototype's solids, so `conv_mesh` and `conv_geometry` run once per prototype solid, in the order the
tree lists them in `meshes`.

### Options

| Key | Name | Default | |
| --- | --- | --- | --- |
| 1 | healing | 1 | 1: OpenCascade's default shape fixing during transfer; 0: none |
| 2 | normals | 1 | 1: `conv_mesh` adds a unit normal per node, taken from the exact surface |
| 3 | geometry face limit | 20000 | `conv_geometry` returns `null` for solids with more faces; 0: no limit |

Key 1 is read once, when `conv_transfer` builds the shapes. Keys 2 and 3 are read by each `conv_mesh` and
`conv_geometry` call, so they may change between calls, for example normals off for a throwaway mesh and on again
for the next. An option keeps its value across files.

## `conv_tree`: JSON

The manifest `converter/oracle/step_to_manifest.py` writes, without `meshes[].groups` (which only meshing can know)
and without `version` (the oracle's command line argument), and with a few additions:

```
{
  "doc": "<name of the first free shape>",
  "units": "mm",
  "source_unit": "<length unit of the file, e.g. mm, inch>",
  "occurrences": [{"path", "parent", "name", "component", "linked": false, "visible": true, "matrix": [16, row-major, mm]}],
  "bodies": [{"occ": "<occurrence path or null>", "body": "<name>", "mesh": <index>, "appearance": "<name or null>"}],
  "meshes": [{"component", "body", "faces": <distinct faces, the face id range>, "bbox": [minX, minY, minZ, maxX, maxY, maxZ]}],
  "appearances": {"rgb(r,g,b)": [["interior_model","integer",0], ["opaque_albedo","color",[r,g,b,255]], ["surface_roughness","float",0.45]], ...},
  "appearance_order": ["<name>", ...],
  "fastener_partners": {}, "sliders": {}, "params": {}
}
```

- Names, paths, matrices, bodies, meshes and appearances follow the Python exactly, except that bodies fall back
  to loose faces where the Python stops at shells (above). With one free shape the output equals the oracle's
  manifest; parity tests compare the two.
- The appearance fields (`interior_model` 0 with `opaque_albedo` and `surface_roughness` 0.45 for an opaque colour,
  3 with `transparent_color` and 0.05 for one with alpha), `linked`, `visible` and the empty `fastener_partners`,
  `sliders` and `params` come from the SeedHammer viewer's Fusion export format and are kept for parity with the
  oracle. A later ABI version may drop them.
- With more than one free shape, each becomes a top-level occurrence named after its label (made unique with
  `:<n>`), so nothing is dropped. Sibling occurrences with the same name are made unique the same way, as the oracle
  does. A label without a name is named by its entry (`0:1:1:3`).
- An instance the file left unnamed carries OpenCascade's placeholder, `=>[0:1:1:2]`. Its occurrence takes the
  component's name, made unique among its siblings like any other.
- `bbox` is conservative: it comes from the geometry's control points and tolerances, before any meshing, so it
  encloses the solid but is not tight around free-form surfaces.
- An assembly nested deeper than 256 levels (a reference cycle in a broken file) is cut there, with a warning.
- `appearances` lists every body colour and every face colour in the file, found during `conv_transfer`, so a mesh's
  groups can refer to them by index in `appearance_order`.
- Colours are sRGB bytes rounded half to even, as Python's `round`; `rgba(r,g,b,0.50)` carries alpha with two
  decimals.
- Numbers are written in the shortest form that reads back to the same double. NaN and infinities never appear;
  a value that would be one is written as `null`, with a warning.

## `conv_mesh`: binary, little-endian

The first part is exactly the oracle's `m_###.bin`:

```
u32 nodeCount
u32 triangleCount
f32 positions[3 * nodeCount]      mm, in the prototype's frame (face locations applied)
u32 indices[3 * triangleCount]    counter-clockwise seen from outside the material (reversed faces flipped; but see
                                  mirroring locations below)
u32 faceIds[triangleCount]        the face's 0-based index in TopExp::MapShapes(solid, TopAbs_FACE)
```

followed by:

```
u32 groupCount
i32 groupAppearance[groupCount]   index into appearance_order, -1 for the body's own colour
u32 groupTriangles[groupCount]
u32 flags                         bit 0: normals follow
f32 normals[3 * nodeCount]        unit normals of the exact surface at each node, on the side the triangles face
```

- Triangles come grouped by colour in the oracle's order: the body's colour first, then face colours sorted by
  name. Nodes are not shared between faces.
- The normals follow the winding: out of the material for a solid whose faces are oriented consistently. A
  reversed face's are reversed with its triangles, and a face's location moves them by its rotation alone, the
  way it moves the winding. So under a mirroring face location (`gp_Trsf::IsNegative`) winding and normals both
  face into the material, and a renderer that draws one side would cull the face. The STEP reader never builds
  such a location; a mirrored assembly placement shows only in the tree's matrices.
- A face that does not mesh is meshed again as NURBS, as in the oracle; one that still fails is left out, with a
  warning.
- Deflection is absolute (mm) and meshing runs on one thread. BRepMesh keeps a face's triangulation when the
  linear deflection it was built with is under 1.1 times the one requested, and compares nothing else. So a
  second `conv_mesh` with a finer linear deflection meshes again; one with a coarser linear deflection, or the
  same one and another angular deflection, returns the existing mesh. `conv_release` first to force a new one.

## `conv_geometry`: JSON

One element of the oracle's `measure.json` `solids` list: `{"p": [...], "e": [...], "f": [...]}` with vertices,
edges and faces numbered like `faceIds`, in the solid's frame, at full precision. The records are described in
`converter/oracle/step_to_manifest.py` (`_edge`, `_face`) and `src/lib/measure/format.ts`. A face or edge whose
extraction fails is written as the generic kind (face kind 5, edge kind 2, or `null` for an edge without a curve)
instead of failing the solid.

- A face without a surface (AP242 tessellated geometry) is written as kind 5 with the area of its triangles and
  whatever loops it has; one warning per solid counts such faces.
- An edge without a record, hidden or failed, is left out of the loops.
- An arc swept less than 5e-7 rad, or 20 m or more in radius, is not written as an arc: the measurement data
  keeps a sweep to 6 decimals, which loses such an arc or part of its length. It becomes a line when it is
  straight within the recognition tolerance (1e-4 mm) and both its vertices are known, else a curve.

## Determinism

No threads, no fused multiply-add (`-ffp-contract=off`), no iteration over hash maps keyed by addresses when the
order reaches the output. The same module and the same bytes give the same output in every engine.
