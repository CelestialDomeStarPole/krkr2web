#include <stdint.h>

#include <emscripten/emscripten.h>
#include "zlib.h"

EMSCRIPTEN_KEEPALIVE uint32_t d5_zlib_adler(const unsigned char *data, uint32_t length) {
    return (uint32_t)adler32(adler32(0L, Z_NULL, 0), data, (uInt)length);
}

EMSCRIPTEN_KEEPALIVE int d5_zlib_uncompress(
    const unsigned char *source,
    uint32_t source_length,
    unsigned char *destination,
    uint32_t destination_length
) {
    uLongf actual_length = (uLongf)destination_length;
    int result = uncompress(destination, &actual_length, source, (uLong)source_length);
    if (result != Z_OK) return result;
    return actual_length == destination_length ? Z_OK : Z_BUF_ERROR;
}

#ifdef D5_ZLIB_ASYNC
EM_ASYNC_JS(int, d5_zlib_pause_once, (), {
    await new Promise(function (resolve) { setTimeout(resolve, 0); });
    return 1;
});

EMSCRIPTEN_KEEPALIVE uint32_t d5_zlib_adler_after_pause(
    const unsigned char *data,
    uint32_t length
) {
    d5_zlib_pause_once();
    return d5_zlib_adler(data, length);
}

EMSCRIPTEN_KEEPALIVE int d5_zlib_uncompress_after_pause(
    const unsigned char *source,
    uint32_t source_length,
    unsigned char *destination,
    uint32_t destination_length
) {
    d5_zlib_pause_once();
    return d5_zlib_uncompress(source, source_length, destination, destination_length);
}
#endif
