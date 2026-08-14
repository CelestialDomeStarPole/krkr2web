// Web storage/file compatibility shim for krkr2 plugins (fstat and friends).
// These platform file operations are declared by krkr2's Platform.h but
// krkrsdl2 (which targets the Emscripten virtual FS) does not implement them.
// Maps each onto the Emscripten FS. (TVP_md5_* and TVPCreateIStream already
// exist in krkrsdl2's SDL2 StorageImpl, so they are not redefined here.)
#include "tjsCommHead.h"
#include "combase.h"
#include "Platform.h"
#include "StorageIntf.h"
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
