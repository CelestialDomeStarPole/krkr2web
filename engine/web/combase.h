#pragma once
// Web shim for krkr2's environ/combase.h.
// krkr2 defines its own COM IStream/IUnknown/GUID in combase.h, but krkrsdl2's
// src/core/base/sdl2/StorageImpl.h already provides an equivalent COM
// abstraction (IStream/IUnknown/GUID/STREAM_SEEK_*/tTVPIStreamAdapter) for the
// SDL2/Emscripten target. Route to it and add only the extra macros and
// stream-creator declarations the ported plugins expect (krkr2 declares
// TVPCreateIStream in base/impl/StorageImpl.h).
#include "StorageImpl.h"
#include "StorageIntf.h"

#ifndef S_OK
#define S_OK ((HRESULT)0L)
#endif
#ifndef S_FALSE
#define S_FALSE ((HRESULT)1L)
#endif
#ifndef E_NOINTERFACE
#define E_NOINTERFACE ((HRESULT)0x80004002L)
#endif
#ifndef E_INVALIDARG
#define E_INVALIDARG ((HRESULT)0x80000003L)
#endif
#ifndef E_FAIL
#define E_FAIL ((HRESULT)0x80004005L)
#endif
#ifndef E_NOTIMPL
#define E_NOTIMPL ((HRESULT)0x80004001L)
#endif
#ifndef E_OUTOFMEMORY
#define E_OUTOFMEMORY ((HRESULT)0x8007000EL)
#endif

// POSIX file-type mask used by fstat; Emscripten's <sys/stat.h> does not always
// expose it.
#ifndef S_IFDIR
#define S_IFDIR 0040000
#endif
#ifndef S_ISDIR
#define S_ISDIR(m) (((m) & S_IFMT) == S_IFDIR)
#endif

IStream *TVPCreateIStream(const ttstr &name, tjs_uint32 flags);
IStream *TVPCreateIStream(tTJSBinaryStream *s);
