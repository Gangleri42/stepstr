# The STEP converter

`converter.wasm` reads a STEP file and produces what the viewer needs: the assembly tree with names, colours and
placements, one mesh per solid with exact surface normals and face ids, and the exact geometry of every vertex,
edge and face for the Measure tool. It is OpenCascade 8.0.1 compiled to a standalone WebAssembly module with a
small C ABI. The same bytes run in a page, a Worker, a sandboxed Nostr napplet and Node; there is no Emscripten
JavaScript, and `loader.js` implements the few WASI calls the module imports.

[ABI.md](ABI.md) is the contract. The Python reference, `oracle/step_to_manifest.py`, defines the semantics; the
converter's output is checked against its occurrence tree, names, matrices, bodies, colour groups, face ids,
triangle winding and measure records.

## Layout

- `src/` the converter. `converter.cpp` reads and transfers the file and walks the XCAF document into the tree.
  `appearance.cpp` collects the colour table, with the oracle's names for colours. `mesh.cpp` writes one solid's
  triangles, normals and colour groups; `geometry.cpp` writes its measure records. `abi.cpp` is the C ABI and the
  error handling. `json.hpp` is a small JSON writer, `warnings.hpp` the warnings a call collects for
  `conv_warnings`, `progress.cpp` the progress callback with the host's stop answer, and `stubs.cpp` the symbols
  OpenCascade references but never uses when it reads from memory. Each `.cpp` except `abi.cpp` and `stubs.cpp` has
  its `.hpp`.
- `loader.js` loads the module in any environment and wraps the ABI in a small API.
- `build.sh` builds everything, reproducibly, inside `emscripten/emsdk:6.0.10`, pinned by digest.
- `test/parity.mjs` compares a conversion with the oracle's output; `test/robustness.mjs` feeds the converter bad
  input and stops its calls.
- `oracle/step_to_manifest.py` the Python reference, from the SeedHammer viewer.

## Build

Docker is the only requirement.

```sh
converter/build.sh
```

The first run fetches OpenCascade `V8_0_1`, by the commit the tag names, into `converter/.build/occt` and applies
two patches: native wasm exceptions instead of Emscripten's JavaScript ones, and no `OCC_CONVERT_SIGNALS`, whose
`setjmp` inside `try` blocks LLVM's wasm lowering cannot express. It then builds the 17 toolkits the converter links
as static libraries, compiles `src/`, links `converter/dist/converter.wasm`, checks that the module imports only what
`ABI.md` allows, and prints its size, gzip size and sha256. The first run takes under ten minutes on a 14-core
machine; later runs recompile `src/` and link.

The ten toolkits where the geometry, healing and meshing time goes are built with `-O3` into
`converter/.build/occt-build`, the seven of the STEP parser and the document with `-Oz` into
`converter/.build/occt-build-cold`. `OCCT_OPT`, `OCCT_COLD_OPT` and `LINK_OPT` (the final link, `-O3`) override the
levels.

To reuse an existing OpenCascade checkout and its wasm builds:

```sh
OCCT_SRC_DIR=/path/to/occt OCCT_BUILD_DIR=/path/to/occt-build OCCT_COLD_BUILD_DIR=/path/to/occt-build-cold converter/build.sh
```

A missing build directory is built from the checkout. Two builds from the same sources give the same bytes, with
one exception: OpenCascade puts a source path into one assertion message, so a checkout mounted at another path
changes a few bytes of the module.

## Test

The oracle writes its output for a STEP file with

```sh
python converter/oracle/step_to_manifest.py model.step out/model --version 1
```

in Python 3.12 with `cadquery-ocp==8.0.1.0.0`, as `scripts/oracle.mjs` runs it. Then:

```sh
node converter/test/parity.mjs converter/dist/converter.wasm model.step out/model
node --experimental-wasm-jspi converter/test/robustness.mjs converter/dist/converter.wasm model.step
```

`parity.mjs` converts the file and compares everything with the oracle. The manifest must match exactly, matrices
to 1e-9. Every mesh must have the oracle's face ids and colour groups, every face's triangles must cover its exact
area, and the normals must be unit length and agree with the winding on every face. Every measure record must
match: kinds, ids and loops exactly, numbers to 1e-9, arcs by their points where a circle fitted to a nearly
straight edge has an ill-conditioned centre. Node and triangle counts are reported but not compared: BRepMesh
splits faces on floating-point comparisons, and a native build with fused multiply-add splits a few differently
from wasm, which has none. The test prints each phase's time and the peak memory, and exits 1 on a mismatch.

`robustness.mjs` feeds the converter bad input and calls out of order, then stops a transfer, a read, a mesh and a
geometry call through `onProgress`, checks that the instance still converts the file completely, and prints how
long after the stop answer each call returned. With `--experimental-wasm-jspi` it also stops a transfer from a
timer through an async listener that yields to the event loop; without the flag that check is skipped.

## Known differences

Parity holds on the two test files. One public file differs: `RC_Buggy_2_front_suspension.stp`, from
pythonocc-demos, gives 11 mismatches over 91 solids. In one body a vertex lies on the other side of a small
circle, with the two arcs that end in it; elsewhere a few face areas differ slightly. Both sides give the same
output on every run; the cause is not yet known.

## Use

```js
import { loadConverter } from './converter/loader.js';

let stop = false; // set by a Cancel button, a deadline...
const converter = await loadConverter(wasmBytes, { onProgress: (phase, done, total) => stop });
const { solids } = converter.open(stepBytes, { healing: true, normals: true, geometryFaceLimit: 20000 });
const tree = converter.tree();
for (let i = 0; i < solids; i++) {
  const mesh = converter.mesh(i, 0.01, 0.3);   // positions, indices, faceIds, normals, groups
  const geometry = converter.geometry(i);      // the measure record, or null past the face limit
  converter.release(i);                        // drops the triangulation once copied out
}
console.log(converter.warnings());
converter.close();
```

`setOptions({ normals, geometryFaceLimit, healing })` changes the options between calls: the first two apply to
each later `mesh` or `geometry` call, `healing` to the next `transfer`. `meshTriangles(i, linear, angular)` meshes
like `mesh` but returns only the triangle count, copying nothing out.

`onProgress(phase, done, total)` is called from the long calls at most every few milliseconds. Phases: 1 read,
2 transfer, 3 mesh, 4 geometry; `done / total` is the phase's progress as a fraction (ABI.md says what each phase
measures). A truthy return stops the call, which throws an `Error` named `AbortError` with `code` `-5`. The
instance stays usable and the next file starts clean: a stopped `transfer` has dropped the parsed file and the
half-built document, a stopped `mesh` the solid's half-built triangulation. A listener that throws stops the call
the same way, and the call throws the listener's error instead of the `AbortError`. A stop lands within tens of
milliseconds in most of a transfer and within a few in a mesh; ABI.md lists where OpenCascade runs longer without
polling.

Errors throw `Error` with the converter's message and `code`: `-1` bad input, `-2` OpenCascade failure, `-3` out
of memory, `-4` anything else, `-5` cancelled. The module stays usable for the next file. OpenCascade is not
hardened against every malformed entity: a file can make it read through a null handle, which traps the module
where the native library would segfault. The loader then throws the `WebAssembly.RuntimeError`, refuses
further calls on that instance, and starts a fresh one from the compiled module at the next `open`.

`read` and `transfer` are the two halves of `open`, so a host can yield between them. With `{ jspi: true }` on an
engine that has `WebAssembly.Suspending` (Chrome, Node with `--experimental-wasm-jspi`), the long calls return
promises and an async `onProgress` yields to the event loop while the converter works. The page stays responsive
without a Worker, and a Cancel handler can run and set the flag the listener returns. Without JSPI a promise from
`onProgress` cannot be awaited and counts as "continue"; a synchronous truthy return still stops the call, for a
deadline in a Worker or a flag in Node.

## Replacing the module

Any module that implements `ABI.md` can replace this one, which `build.sh` rebuilds from source. A replacement goes
in as the bytes the host loads: `converter.wasm`, or `converter.txt`, its gzipped base64, which a napplet fetches by
sha256 (the napplet build takes another module from `CONVERTER_WASM`). `conv_abi()` names the ABI version and
`loader.js` refuses any other; `test/parity.mjs` shows whether a replacement gives the oracle's answers.

## License

Everything in this directory except OpenCascade's licence texts is in the public domain, like the rest of stepstr
([LICENSE](../LICENSE)). The module it builds contains Open CASCADE Technology, linked statically, which is licensed
under the GNU LGPL 2.1 ([LICENSE_LGPL_21.txt](LICENSE_LGPL_21.txt)) with the Open CASCADE exception
([OCCT_LGPL_EXCEPTION.txt](OCCT_LGPL_EXCEPTION.txt)). The exception lets code compiled against OpenCascade's headers,
as this converter is, carry terms of its own. The LGPL asks that users can rebuild the module with a modified
OpenCascade: `build.sh` builds the OpenCascade commit it pins from source, and a rebuilt module replaces this one as
described above.
