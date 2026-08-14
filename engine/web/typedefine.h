#pragma once
// Web shim for krkr2's environ/typedefine.h.
// The Windows-compatible types (DWORD, HRESULT, FILETIME, LARGE_INTEGER, ...)
// krkr2 defines here already exist in krkrsdl2's src/core/base/sdl2/StorageImpl.h
// for the SDL2/Emscripten target. Route to it instead of re-defining.
#include "StorageImpl.h"
