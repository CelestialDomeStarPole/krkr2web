# Worker/GPU engine boundary

The target device runs a Chromium 89 WebView without cross-origin isolation.
That rules out SharedArrayBuffer, Emscripten pthreads, Wasm exception handling,
JSPI and Wasm SIMD. The engine runtime must therefore be one single-threaded
Wasm instance inside a Dedicated Worker. The page owns only DOM media, audio,
input capture and lifecycle controls.

## Runtime boundary

- Transfer the game canvas to the engine Worker as an `OffscreenCanvas`.
- Build with `ENVIRONMENT=web,worker`, `OFFSCREENCANVAS_SUPPORT=1`, `ASYNCIFY=1`
  and `MODULARIZE=1`.
- Do not build or select a `USE_PTHREADS` / `PROXY_TO_PTHREAD` artifact.
- Deliver input through exported C functions that create `SDL_Event` values and
  call `SDL_PushEvent` inside the Worker.
- Route video, browser dialogs and audio through asynchronous messages carrying
  both a session id and a request id.
- Treat `worker.terminate()` as the hard-stop primitive. Engine code is never
  allowed to synchronously call back into the page thread.
- Keep the existing IndexedDB chunk store. In the Worker it remains async through
  Asyncify and accesses `globalThis.indexedDB` directly.

The machine-readable version of this contract is
`engine/worker-runtime-contract.json`; `tools/check_worker_contract.py` rejects
build plans and glue that violate it.

## GPU source boundary

Use `fenghengzhi/kirikiroid2-web` commit
`338d2029f16969b84becfd163c67f99740e28296` as the GPU reference. It already
contains the coherent KRKR2 Layer/RenderManager ABI, WebGL renderer, mobile
shader fixes and the motionplayer implementation verified against the Android
binary.

Do not copy individual transition or texture files into krkrsdl2. The coherent
migration unit is the full `cpp/core` tree plus `cpp/plugins/motionplayer`,
`cpp/plugins/psbfile` and its patched Cocos2d platform. Layer bitmap ownership,
render targets, transitions, graphics loading and the draw device share one ABI.
Mixing either side recreates CPU copies and invalid texture ownership.

Keep these parts owned by krkr2web rather than importing the reference host:

- `platforms/web`: it assumes a page-thread engine and a custom shell.
- `VirtualLazyFS.*` and `vlfs.js`: they require JSPI or pthread proxying.
- Web audio and FFmpeg movie hosts: they require page APIs or pthreads.
- PWA, picker, OPFS and save UI: the current product already owns these flows.

## Chrome 89 replacement map

Remove `-pthread`, `PTHREAD_POOL_SIZE`, `-fwasm-exceptions`, `-msimd128`, `JSPI`
and `JSPI_EXPORTS` from the reference CMake and vcpkg triplet. Exclude
`jspi_jsc_mainloop_fix.js`. Replace the Cocos Emscripten main loop with the
Worker-owned main loop, replace VLFS with the current IndexedDB/Asyncify bridge,
and replace audio/movie implementations with host messages. Any remaining
`std::thread` paths in image loading, timers, audio or FFmpeg must use the
cooperative single-thread implementations already proven by the baseline
krkrsdl2 build.

The first GPU milestone is complete only when the final layer texture is drawn
directly to the default WebGL framebuffer and presented by the same Worker. A
path that still composites every layer into a CPU bitmap and calls
`SDL_UpdateTexture` is a compatibility fallback, not the GPU migration.
