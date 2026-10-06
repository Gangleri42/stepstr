#!/bin/bash
# Builds dist/converter.wasm: OpenCascade V8_0_1 as static wasm libraries, then the converter linked standalone.
# Everything runs inside the emscripten/emsdk:6.0.10 image with this directory mounted at /src, so the result is
# the same on every machine.
#
#   ./build.sh                                        fetch, patch and build OpenCascade into .build/, then link
#   OCCT_SRC_DIR=... OCCT_BUILD_DIR=... ./build.sh    reuse an OpenCascade V8_0_1 checkout and its wasm build of
#                                                     the hot toolkits (OCCT_COLD_BUILD_DIR: of the cold ones)
#
# Environment: OCCT_OPT (default -O3) for the toolkits the geometry work runs in, OCCT_COLD_OPT (default -Oz) for
# the STEP parser and document toolkits, LINK_OPT (default -O3) for the final link.
set -euo pipefail
cd "$(dirname "$0")"

# The image by digest and OpenCascade by commit: a tag can be moved and an image retagged, and the lock records the
# build these two give. The tag and the version are for humans.
IMAGE=emscripten/emsdk:6.0.10@sha256:e077d54e2b8970575ebc4f185ac1de0b95c05f2b266134d4ba27449af7aebf65
OCCT_REPO=https://github.com/Open-Cascade-SAS/OCCT.git
OCCT_TAG=V8_0_1
OCCT_COMMIT=b8f597c677811d1f9f4d8a97f5ae2825c0353a42
# What the converter links. XCAF's visualisation toolkits (TKV3d, TKService, TKVCAF) and TKHLR, TKBO and TKPrim
# contribute no code to the module: the link map shows nothing reachable from them. Each list starts with the
# toolkit that depends on all the others, whose library the build writes last.
# The geometry, healing and meshing toolkits, where the time goes: built for speed.
HOT_TOOLKITS="TKMesh TKShHealing TKTopAlgo TKGeomAlgo TKBRep TKGeomBase TKG3d TKG2d TKMath TKernel"
# The STEP parser and the document toolkits: 40% of the code, a fraction of the time. Built for size, which
# takes 170 KB off the gzipped module and costs about a tenth of the parsing phase.
COLD_TOOLKITS="TKDESTEP TKXSBase TKXCAF TKLCAF TKCAF TKCDF TKDE"
EXPORTS=_conv_abi,_conv_set_option,_conv_alloc,_conv_read,_conv_transfer,_conv_tree,_conv_mesh,_conv_geometry,\
_conv_warnings,_conv_release,_conv_close,_conv_result_ptr,_conv_error
# The only imports the module may have; loader.js implements exactly these.
ALLOWED_IMPORTS="wasi_snapshot_preview1.fd_write wasi_snapshot_preview1.fd_close wasi_snapshot_preview1.fd_seek \
wasi_snapshot_preview1.fd_read wasi_snapshot_preview1.environ_sizes_get wasi_snapshot_preview1.environ_get \
wasi_snapshot_preview1.clock_time_get wasi_snapshot_preview1.random_get wasi_snapshot_preview1.proc_exit \
env.emscripten_notify_memory_growth env.conv_progress"

if [ -z "${STEPSTR_IN_CONTAINER:-}" ]; then
  mounts=(-v "$PWD:/src")
  environment=(-e STEPSTR_IN_CONTAINER=1 -e "OCCT_OPT=${OCCT_OPT:-}" -e "OCCT_COLD_OPT=${OCCT_COLD_OPT:-}"
               -e "LINK_OPT=${LINK_OPT:-}")
  if [ -n "${OCCT_BUILD_DIR:-}${OCCT_COLD_BUILD_DIR:-}" ] && [ -z "${OCCT_SRC_DIR:-}" ]; then
    echo "an OpenCascade build dir needs OCCT_SRC_DIR, the checkout it was built from (its headers)" >&2
    exit 1
  fi
  if [ -n "${OCCT_SRC_DIR:-}" ]; then
    mounts+=(-v "$(cd "$OCCT_SRC_DIR" && pwd):/occt-src")
    environment+=(-e OCCT_SRC_DIR=/occt-src)
  fi
  if [ -n "${OCCT_BUILD_DIR:-}" ]; then
    mounts+=(-v "$(cd "$OCCT_BUILD_DIR" && pwd):/occt-build:ro")
    environment+=(-e OCCT_BUILD_DIR=/occt-build)
  fi
  if [ -n "${OCCT_COLD_BUILD_DIR:-}" ]; then
    mounts+=(-v "$(cd "$OCCT_COLD_BUILD_DIR" && pwd):/occt-build-cold:ro")
    environment+=(-e OCCT_COLD_BUILD_DIR=/occt-build-cold)
  fi
  exec docker run --rm "${mounts[@]}" "${environment[@]}" -w /src "$IMAGE" bash build.sh "$@"
fi

# ---- inside the container ------------------------------------------------------------------------------------------

OCCT_SRC=${OCCT_SRC_DIR:-/src/.build/occt}
OCCT_BUILD=${OCCT_BUILD_DIR:-/src/.build/occt-build}
OCCT_COLD_BUILD=${OCCT_COLD_BUILD_DIR:-/src/.build/occt-build-cold}
OCCT_OPT=${OCCT_OPT:--O3}
OCCT_COLD_OPT=${OCCT_COLD_OPT:--Oz}
LINK_OPT=${LINK_OPT:--O3}
# Native wasm exceptions and setjmp, and no fused multiply-add: the same bits on every engine.
CODEGEN="-fwasm-exceptions -sSUPPORT_LONGJMP=wasm -ffp-contract=off"
mkdir -p .build dist

if [ ! -f "$OCCT_SRC/CMakeLists.txt" ]; then
  echo "== fetching OpenCascade $OCCT_TAG ($OCCT_COMMIT)"
  git init -q "$OCCT_SRC"
  git -C "$OCCT_SRC" fetch -q --depth 1 "$OCCT_REPO" "$OCCT_COMMIT"
  git -C "$OCCT_SRC" checkout -q FETCH_HEAD
fi
# A checkout that is there already is used as it is when it is at the commit; the mounted files may belong to
# another user than the container's, which git would otherwise refuse to look at.
occt_head=$(git -c safe.directory='*' -C "$OCCT_SRC" rev-parse HEAD 2>/dev/null || true)
if [ -z "$occt_head" ]; then
  echo "warning: $OCCT_SRC is not a git checkout, so it cannot be checked against $OCCT_TAG ($OCCT_COMMIT)" >&2
elif [ "$occt_head" != "$OCCT_COMMIT" ]; then
  echo "$OCCT_SRC is at $occt_head, not $OCCT_TAG ($OCCT_COMMIT): remove it and its build directories, or point" \
       "OCCT_SRC_DIR at a checkout of that commit" >&2
  exit 1
fi

patch_occt() {
  # OpenCascade asks for -fexceptions, Emscripten's JavaScript exceptions; the converter uses native wasm ones.
  sed -i 's/-fexceptions/-fwasm-exceptions/g' "$OCCT_SRC/adm/cmake/occt_defs_flags.cmake"
  # There are no signals to convert in wasm. With OCC_CONVERT_SIGNALS, OCC_CATCH_SIGNALS puts setjmp inside try
  # blocks, which LLVM's wasm setjmp lowering turns into invalid code (ShapeUpgrade_ShapeDivide::Perform).
  sed -i '/add_definitions(-DOCC_CONVERT_SIGNALS)/d' "$OCCT_SRC/adm/cmake/occt_defs_flags.cmake"
}

# build_toolkits <build dir> <optimisation> <toolkits>: static wasm libraries, unless they are there already. The
# first toolkit's library is the last one written, so its presence means the build finished; an interrupted build
# runs again and cmake picks it up where it stopped.
build_toolkits() {
  local dir=$1 opt=$2 toolkits=$3 last=${3%% *}
  if [ -n "$(find "$dir" -name "lib$last.a" 2>/dev/null)" ]; then return; fi
  echo "== building OpenCascade toolkits ($opt): $toolkits"
  patch_occt
  emcmake cmake -S "$OCCT_SRC" -B "$dir" \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS_RELEASE="$opt -DNDEBUG" -DCMAKE_C_FLAGS_RELEASE="$opt -DNDEBUG" \
    -DBUILD_LIBRARY_TYPE=Static -DBUILD_MODULE_Draw=OFF -DBUILD_DOC_Overview=OFF -DBUILD_GTEST=OFF \
    -DBUILD_RESOURCES=OFF -DUSE_FREETYPE=OFF -DUSE_FREEIMAGE=OFF -DUSE_TK=OFF -DUSE_TBB=OFF -DUSE_VTK=OFF \
    -DUSE_RAPIDJSON=OFF -DUSE_DRACO=OFF -DUSE_OPENVR=OFF -DUSE_FFMPEG=OFF -DUSE_GLES2=OFF -DUSE_OPENGL=OFF \
    -DUSE_XLIB=OFF -DCMAKE_C_FLAGS="$CODEGEN" -DCMAKE_CXX_FLAGS="$CODEGEN" -DINSTALL_DIR=/src/.build/occt-install
  # shellcheck disable=SC2086
  cmake --build "$dir" -j"$(nproc)" --target $toolkits
}
build_toolkits "$OCCT_BUILD" "$OCCT_OPT" "$HOT_TOOLKITS"
build_toolkits "$OCCT_COLD_BUILD" "$OCCT_COLD_OPT" "$COLD_TOOLKITS"
HOT_LIBDIR=$(dirname "$(find "$OCCT_BUILD" -name libTKernel.a | head -1)")
COLD_LIBDIR=$(dirname "$(find "$OCCT_COLD_BUILD" -name libTKDESTEP.a | head -1)")

# One flat include directory of the OpenCascade headers, plus the generated Standard_Version.hxx.
INCLUDE=/src/.build/include
if [ ! -f "$INCLUDE/.complete" ]; then
  echo "== collecting headers"
  rm -rf "$INCLUDE"
  mkdir -p "$INCLUDE"
  find "$OCCT_SRC/src" -type f \( -name '*.hxx' -o -name '*.lxx' -o -name '*.gxx' -o -name '*.h' -o -name '*.pxx' \) \
    -exec ln -sf -t "$INCLUDE" {} +
  cp "$(find "$OCCT_BUILD" -name Standard_Version.hxx | head -1)" "$INCLUDE/"
  touch "$INCLUDE/.complete"
fi

echo "== compiling the converter"
# From scratch each time, so a deleted or renamed source leaves no stale object in the link.
rm -rf .build/obj
mkdir -p .build/obj
CXXFLAGS="-std=c++20 -O3 $CODEGEN -DNDEBUG -Wall -Wextra -I$INCLUDE"
ls src/*.cpp | xargs -P "$(nproc)" -I{} sh -c 'em++ '"$CXXFLAGS"' -c {} -o .build/obj/$(basename {} .cpp).o'

echo "== linking ($LINK_OPT)"
# shellcheck disable=SC2086
em++ $LINK_OPT -g0 $CODEGEN .build/obj/*.o -o dist/converter.wasm \
  -sSTANDALONE_WASM --no-entry -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB \
  -sABORTING_MALLOC=0 -sEXPORTED_FUNCTIONS="$EXPORTS" -sERROR_ON_UNDEFINED_SYMBOLS=1 \
  $(for t in $COLD_TOOLKITS; do printf ' %s/lib%s.a' "$COLD_LIBDIR" "$t"; done) \
  $(for t in $HOT_TOOLKITS; do printf ' %s/lib%s.a' "$HOT_LIBDIR" "$t"; done)

echo "== checking imports"
node - dist/converter.wasm "$ALLOWED_IMPORTS" <<'EOF'
const [file, allowed] = process.argv.slice(2);
const module = new WebAssembly.Module(require('node:fs').readFileSync(file));
const ok = new Set(allowed.split(/\s+/));
const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
const extra = imports.filter((i) => !ok.has(i));
console.log(`imports: ${imports.join(' ')}`);
if (extra.length) {
  console.error(`unexpected imports: ${extra.join(' ')}`);
  process.exit(1);
}
EOF

echo "== dist/converter.wasm"
echo "size:   $(stat -c %s dist/converter.wasm) bytes"
echo "gzip:   $(gzip -9 -c dist/converter.wasm | wc -c) bytes"
echo "sha256: $(sha256sum dist/converter.wasm | cut -d' ' -f1)"
