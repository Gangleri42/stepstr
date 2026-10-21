<h1>
	<picture>
		<source media="(prefers-color-scheme: dark)" srcset="brand/logo-night.svg">
		<img src="brand/logo.svg" alt="stepstr" height="56">
	</picture>
</h1>

stepstr opens a STEP file in the browser and shows its assembly tree, section cuts, exploded views and exact
measurements, with links that reopen the same view. It runs as a web page, at [stepstr.space](https://stepstr.space),
and as a Nostr napplet, so any napplet host can show a STEP file with it.

The file is converted on the device that opens it. OpenCascade, compiled to WebAssembly, reads it and produces the
tree, colours, face ids and exact geometry the viewer works on. Nothing is uploaded.

stepstr is a work in progress, derived from the [SeedHammer viewer](https://github.com/Gangleri42/seedhammer-viewer).

## Layout

- `converter/`: the STEP converter (C++ on OpenCascade, compiled to WebAssembly), its interface (`converter/ABI.md`)
  and the Python reference its output is checked against (`converter/oracle/`)
- `src/lib/convert/`: a conversion, the converter followed by the pipeline; in a Worker on the web, on the main thread
  in a napplet
- `src/lib/pipeline/`: meshes, the GLB and the measurement data
- `src/lib/viewer/`: the three.js scene with parts, section cuts, explode and the Measure tool
- `src/lib/measure/`: measurements on the exact geometry
- `src/lib/source/` and `src/lib/host/`: where files come from (links, Blossom, Nostr events, this device), and the
  two environments the viewer runs in
- `src/lib/state/`: the route, which encodes the whole view; `src/lib/recent/`: recently viewed files
- `src/napplet/` and `vite.napplet.config.ts`: the napplet build; `scripts/dev-shell/`: a local shell to try it in
- `pipeline/`: tools that run in Node, such as publishing to Nostr
- `test/`: the test files, pinned by sha256, and the expected conversion results; `e2e/`: the browser tests
- `brand/`: the logo's sources; `scripts/brand.mjs` renders the icons in `static/` from them

## Develop

```sh
npm install
converter/build.sh    # converter/dist/converter.wasm, in Docker; a few minutes the first time
npm run converter:fetch   # or the same build, by its sha256, from the Blossom servers that hold it
npm run dev           # the web page at http://localhost:5173
npm run fixtures      # the test files, fetched by sha256 into .cache/fixtures
npm run oracle        # the Python oracle's output for them, into .cache/oracle; needs uv
npm test              # STEPSTR_SLOW=1 adds Hammer, about a minute
npm run check
npx playwright install chromium firefox webkit   # once
npm run test:e2e      # the web page and the napplet in Chromium, Firefox and WebKit
```

A test that needs the converter build, a test file, the oracle's output or the napplet build skips when it is
missing. To make every test run or fail by name:

```sh
STEPSTR_STRICT=1 STEPSTR_SLOW=1 npm test
```

Both builds and the publishing tools read `.nsite/config.json` for the site they make. `STEPSTR_SITE=<dir>` makes them
for another site from the same checkout: they read `<dir>/.nsite/config.json` and write `<dir>/build` and
`<dir>/dist-napplet`.

## Opening files

Paste a link, drop a file or choose one. A link can be a GitHub file (page links become raw links; Git LFS files are
followed), any https URL served with CORS headers, a Blossom blob (`blossom:`, BUD-01 or BUD-10), or a Nostr event that
points at a STEP file (`nevent1…`, `naddr1…`: a NIP-94 file event, or any event with imeta tags). Zipped and gzipped
STEP files are unpacked.

Files opened before are listed under Recently viewed, each with a picture, and reopen in the view they were left in.
The list stays on the device. The web page also keeps each file's converted model in IndexedDB, and the bytes of files
chosen from the device, so they reopen without a download or a conversion. It keeps up to 400 MB, or half of what the
browser grants the site if that is less, and drops the oldest first. A new version of the converter or of the
conversion code converts every kept model again. A napplet keeps the list, and as many pictures as fit, in the shell's
storage (NAP-STORAGE, 512 KB); it downloads and converts a file again when it reopens, and asks again for a file from
the device.

The web page can be installed as an app and works offline. A service worker (`src/service-worker.ts`, registered in
production builds only) caches the current build's page, code, converter and icons, about 10 MB, and serves them
when there is no network. Files from the device then open offline; links still need the network. A napplet has no
service worker; what it can do offline depends on its shell.

Without a JavaScript JIT the converter runs in an interpreter and takes several times longer. GrapheneOS's Vanadium
works that way unless the JIT is allowed for the site, and the page says so while it converts.

The URL hash encodes the view, so a link reopens it:

```
#/b/<sha256>.step?xs=<server>&name=part.step&cut=x:12.5!    a Blossom blob, or a file from this device
#/u?src=<https url>&x=<sha256>&iso=k3x9a1                    a file on the web, pinned to its bytes by x
#/n/<nevent1…>?x=<sha256>&m=k3x9a1.f12.q7,0f2kq7.c40.3b      the file a Nostr event points at
```

| key     | value                                                                 |
| ------- | --------------------------------------------------------------------- |
| `xs`    | a Blossom server that holds the blob (repeatable)                     |
| `x`     | sha256 the file must have                                             |
| `name`  | the file's name                                                       |
| `hide`  | part ids to hide                                                      |
| `iso`   | show only these parts                                                 |
| `cut`   | `axis:offset` in mm, `!` keeps the positive side; up to three          |
| `ex`    | explode, 0 to 1                                                       |
| `cam`   | camera position; target; orthographic zoom                            |
| `sel`   | selected part                                                         |
| `m`     | up to two measured items; only in routes pinned to exact bytes        |
| `edges` | `0` hides edge lines                                                  |
| `ortho` | `1` for orthographic                                                  |
| `up`    | the file's axis that points up: `y`, `x`, `-z`, `-y` or `-x`; Z if absent |

## As a napplet

stepstr is a NIP-5D napplet (manifest kind 35129, `d=stepstr`) with the `3d-model` archetype: a napplet that displays
one 3D model or assembly for inspection. It requires only `inc` and `resource`, and uses `theme`, `link`, `outbox`,
`fs` and `storage` when the shell offers them.

The manifest follows NIP-5D as of 2026-10-05: it names the one page, `index.html`, by its sha256 (`x`), carries the
description as its content, and declares the archetype (`z`), the intent with its parameters (`i`) and the required and
optional shell domains (`R`, `O`). The build writes the same declarations into the page's head, where NIP-5D maps them,
and reads the manifest from there. Shells released before that date expect the older shape, with `path` tags and an
aggregate hash, and do not load this one yet.

Other napplets and shells open a file with the `napplet:3d-model/open` convention. Its payload's fields are strings:
`url` (https, `blossom:sha256:<hex>` or `nostr:<bech32>`), `sha256`, `servers` (space-separated Blossom servers),
`name`, `view` (view keys in the route grammar, such as `cut=x:1&ortho=1`) and `route` (a full stepstr route, which
takes precedence over the other fields). A host that already has the file's bytes can pass them as `data` (a Blob).
The napplet also listens on `3d-model:open` and emits `3d-model:ready`, as stlstr does for its preview napplets.

A napplet has no network of its own and asks the shell for every file, the converter included. The page is about
1.1 MB. The converter is published beside it as `converter.txt` (converter.wasm, gzipped and base64-encoded, 4.4 MB;
text, because every shell passes text through). It is a separate Blossom blob that no manifest lists. The page embeds
its sha256 and fetches it through the shell (`blossom:sha256:<hex>`, with the Blossom servers as hints) when the first
file is opened, while that file downloads. Shells limit what they pass. Kehto Paja passes files up to 10 MiB and
only plain text or images, so a STEP file opens there by link when it is plain ASCII and small enough. Other files can
be chosen from the device (through the shell's `fs`) or opened in the web viewer.

To try the napplet locally:

```sh
npm run build:napplet      # dist-napplet: index.html, converter.txt and the manifest template
npm run dev:shell          # http://127.0.0.1:4180: a shell with Paja's sandbox rules, intent presets, file picking,
                           # serving the napplet's files by sha256 as its Blossom servers would
npm run test:conformance   # the NAP conformance suite
npm run paja               # the napplet in Kehto Paja, served by the dev server (which serves the converter too)
```

## License

stepstr is in the public domain, see [LICENSE](LICENSE). The converter module it builds contains Open CASCADE
Technology, which is licensed under the LGPL 2.1 with the Open CASCADE exception;
[converter/README.md](converter/README.md#license) says what that covers and how to rebuild the module and swap a
build in. The logo's wordmark is set in Space Grotesk, under the SIL Open Font License.
