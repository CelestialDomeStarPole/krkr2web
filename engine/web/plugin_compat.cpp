// Web storage/file compatibility shim for krkr2 plugins (fstat and friends).
// These platform file operations are declared by krkr2's Platform.h /
// StorageImpl.h but krkrsdl2 (which targets the Emscripten virtual FS) does not
// implement them. Maps each onto the Emscripten FS / krkrsdl2 storage.
#include "tjsCommHead.h"
#include "combase.h"
#include "Platform.h"
#include "StorageIntf.h"
#include "md5.h"
#include <sys/stat.h>
#include <unistd.h>
#include <cstring>
#include <cstdio>

// sys/stat.h defines st_atime/st_mtime/st_ctime as macros; undef them so the
// tTVP_stat struct fields of the same name are not macro-expanded.
#ifdef st_atime
#undef st_atime
#endif
#ifdef st_mtime
#undef st_mtime
#endif
#ifdef st_ctime
#undef st_ctime
#endif

// ---- file stat / time ----

static std::string resolveLocal(const ttstr &name) {
    ttstr n(name);
    TVPNormalizeStorageName(n);
    TVPGetLocalName(n);
    return n.AsNarrowStdString();
}

bool TVP_stat(const tjs_char *name, tTVP_stat &s) {
    return TVP_stat(ttstr(name).AsNarrowStdString().c_str(), s);
}

bool TVP_stat(const char *name, tTVP_stat &s) {
    struct stat st;
    if (::stat(name, &st) != 0)
        return false;
    s.st_mode = (uint16_t)st.st_mode;
    s.st_size = (uint64_t)st.st_size;
    s.st_atime = (uint64_t)st.st_atim.tv_sec;
    s.st_mtime = (uint64_t)st.st_mtim.tv_sec;
    s.st_ctime = (uint64_t)st.st_ctim.tv_sec;
    return true;
}

bool TVP_utime(const char *name, time_t modtime) {
    (void)name;
    (void)modtime;
    // Emscripten FS has no portable utime; timestamp updates are not critical
    // for save bookkeeping on the web target, so this is a successful no-op.
    return true;
}

// ---- file copy / rename / delete ----

bool TVPCopyFile(const std::string &from, const std::string &to) {
    FILE *in = std::fopen(from.c_str(), "rb");
    if (!in)
        return false;
    FILE *out = std::fopen(to.c_str(), "wb");
    if (!out) {
        std::fclose(in);
        return false;
    }
    char buf[65536];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof(buf), in)) > 0)
        std::fwrite(buf, 1, n, out);
    std::fclose(in);
    std::fclose(out);
    return true;
}

bool TVPRenameFile(const std::string &from, const std::string &to) {
    return std::rename(from.c_str(), to.c_str()) == 0;
}

bool TVPDeleteFile(const std::string &filename) {
    return std::remove(filename.c_str()) == 0;
}

std::vector<std::string> TVPGetAppStoragePath() {
    std::vector<std::string> r;
    r.push_back("/savedata");
    return r;
}

// ---- MD5 ----

// Mirrors krkr2 PluginImpl.h: a fixed buffer large enough for md5_state_t.
typedef struct TVP_md5_state_s {
    tjs_uint8 buffer[4 * 2 + 8 + 4 * 4 + 8 + 64];
} TVP_md5_state_t;

void TVP_md5_init(TVP_md5_state_t *pms) { md5_init((md5_state_t *)pms); }
void TVP_md5_append(TVP_md5_state_t *pms, const tjs_uint8 *data, int nbytes) {
    md5_append((md5_state_t *)pms, (const md5_byte_t *)data, nbytes);
}
void TVP_md5_finish(TVP_md5_state_t *pms, tjs_uint8 *digest) {
    md5_finish((md5_state_t *)pms, (md5_byte_t *)digest);
}

// ---- IStream adapter (tTJSBinaryStream -> IStream) ----

class tTVPIStreamAdapter : public IStream {
    tTJSBinaryStream *Stream;

public:
    explicit tTVPIStreamAdapter(tTJSBinaryStream *s) : Stream(s) {}
    virtual ~tTVPIStreamAdapter() { delete Stream; }

    // IUnknown
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void **ppv) override {
        if (ppv)
            *ppv = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
    ULONG STDMETHODCALLTYPE Release() override {
        delete this;
        return 0;
    }

    // ISequentialStream
    HRESULT STDMETHODCALLTYPE Read(void *pv, ULONG cb, ULONG *pcbRead) override {
        tjs_uint r = Stream->Read(pv, cb);
        if (pcbRead)
            *pcbRead = r;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE Write(const void *pv, ULONG cb,
                                   ULONG *pcbWritten) override {
        tjs_uint w = Stream->Write(pv, cb);
        if (pcbWritten)
            *pcbWritten = w;
        return S_OK;
    }

    // IStream
    HRESULT STDMETHODCALLTYPE Seek(LARGE_INTEGER dlibMove, DWORD dwOrigin,
                                  ULARGE_INTEGER *plibNewPosition) override {
        tjs_int whence = TJS_BS_SEEK_SET;
        switch (dwOrigin) {
        case STREAM_SEEK_CUR:
            whence = TJS_BS_SEEK_CUR;
            break;
        case STREAM_SEEK_END:
            whence = TJS_BS_SEEK_END;
            break;
        }
        Stream->Seek(dlibMove.QuadPart, whence);
        if (plibNewPosition)
            plibNewPosition->QuadPart = Stream->GetPosition();
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE SetSize(ULARGE_INTEGER) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE CopyTo(IStream *, ULARGE_INTEGER,
                                     ULARGE_INTEGER *, ULARGE_INTEGER *) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE Commit(DWORD) override { return S_OK; }
    HRESULT STDMETHODCALLTYPE Revert() override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE LockRegion(ULARGE_INTEGER, ULARGE_INTEGER,
                                         DWORD) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE UnlockRegion(ULARGE_INTEGER, ULARGE_INTEGER,
                                           DWORD) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE Stat(STATSTG *, DWORD) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE Clone(IStream **) override { return E_NOTIMPL; }
};

IStream *TVPCreateIStream(tTJSBinaryStream *s) {
    return new tTVPIStreamAdapter(s);
}

IStream *TVPCreateIStream(const ttstr &name, tjs_uint32 flags) {
    tTJSBinaryStream *stream0 = nullptr;
    try {
        stream0 = TVPCreateStream(name, flags);
    } catch (...) {
        delete stream0;
        return nullptr;
    }
    return new tTVPIStreamAdapter(stream0);
}
