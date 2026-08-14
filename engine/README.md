# D3 engine baseline

The browser engine is built from `krkrsdl2` at the commit recorded in
`upstream.json`. The upstream checkout under `参考资料/开源项目/` is research input
only and is never modified by the build.

`tools/build_d3.ps1` copies the locked checkout into ignored build storage,
applies every patch in `engine/patches/`, and produces the D3 web probe. This
keeps the project-owned changes reviewable without committing about 225 MiB of
third-party source.

The D3 browser build deliberately uses:

- one Wasm/main-thread runtime, without pthreads or SharedArrayBuffer;
- Asyncify for synchronous KRKR2 calls that wait on IndexedDB;
- Chrome 89 `DecompressionStream` for XP3 indices and compressed resource segments;
- the D2 `krkr2web` database for immutable XP3 chunks;
- Emscripten IDBFS mounted at `/savedata/<gameId>` for mutable saves;
- a four-entry, 4 MiB-per-entry XP3 LRU cache.

The second D3 desktop gate proves XP3 parsing, TJS execution, BMP and embedded
font rendering, mouse input, PCM WAV playback, IDBFS save writes and save
restoration after a page reload. The third gate imports `KAGParser.cpp/.h` from
the locked `krkr2` source listed in `upstream.json`, registers it with TJS and
executes a real `.ks` scenario covering jumps, macros, conditions and choices.
Its project patch also restores the saved parser line and column instead of
restarting at the containing label. Imported source hashes, patches and license
texts are included in the build audit output.

The browser smoke test checks canvas pixels, scene changes, KAG branch state,
same-position restoration after reload, cross-page evidence and diagnostic
report upload. The Web patch binds `FS.syncfs` at compile time so saves work
with `DYNAMIC_EXECUTION=0`.

The enhanced-input desktop gate uses the existing SDL Emscripten keyboard and
game-controller backends. It proves paired key-down/key-up delivery into TJS,
KRKR virtual-key mapping, navigation, confirm and cancel actions, and a real KAG
branch save. It does not add a JavaScript-to-TJS test bypass. The target device
cannot attach these peripherals, so keyboard and gamepad validation is desktop
only; target-device touch validation remains mandatory and has passed.

Only the 30-minute target-device engine run remains within D3. This focused
probe must not be reported as the complete generic playable loop.
