#include <webp/decode.h>
#include "tjsCommHead.h"
#include "GraphicsLoaderIntf.h"
#include "MsgIntf.h"
#include "tjsDictionary.h"
#include <memory>
#include <cstring>

// WebP graphic loader adapted for krkrsdl2's graphic loader API (3-arg size
// callback + per-scanline scanline callback). Original: kirikiroid2-web LoadWEBP.cpp.

#ifdef __EMSCRIPTEN__
#include <emscripten.h>

// krkr2web: off-main-thread WebP decode. wasm libwebp needs 40-100ms per
// 720p-class image ON the main thread - long enough to starve the OpenAL
// scheduler (25ms interval, 100ms lookahead) and drop audio on every
// click-next sprite swap. The page's decoder (play/prefetch.js) decodes via
// createImageBitmap inside a worker, i.e. on the browser's native decoder
// threads; the engine Asyncify-suspends in the await below, so the JS event
// loop (audio scheduling, input) keeps running.
//
// Two phases keep the destination pointer safe: phase 1 awaits the decode
// and reports the dimensions; phase 2 performs the synchronous copy. No
// suspension happens between the phases, so no other callback can run wasm
// code (and grow the heap) in between.
//
// The await is raced against an 8s timeout and publishes an async trace:
// without the timeout a WebView whose createImageBitmap never settles (or
// whose decode worker is blocked) suspends the engine forever - field
// reports showed 40s+ main-loop stalls with no pending-op trace, because
// this was the only untraced, timeout-less suspension left in the engine.
EM_ASYNC_JS(int, krkr2web_webp_request, (int bgra, const unsigned char *src, int len, int w, int h),
{
	const decoder = globalThis.krkr2webImageDecoder;
	if (!decoder || typeof decoder.decode != 'function') return 0;
	const trace = {
		op: "webp-native-decode",
		detail: len + " bytes -> " + w + "x" + h,
		startedAt: Date.now()
	};
	globalThis.krkr2webAsyncTrace = trace;
	try {
		const bytes = HEAPU8.slice(src, src + len);
		const info = await Promise.race([
			decoder.decode('', bytes, bgra != 0),
			new Promise(function (resolve, reject) {
				setTimeout(function () { reject(new Error('webp decode timeout after 8000 ms')); }, 8000);
			})
		]);
		if (!info || !info.rgba || info.w != w || info.h != h) return 0;
		decoder.pending = { rgba: info.rgba };
		return ((info.w & 0xffff) << 16) | (info.h & 0xffff);
	} catch (e) { return 0; }
	finally { if (globalThis.krkr2webAsyncTrace === trace) globalThis.krkr2webAsyncTrace = null; }
});

EM_JS(int, krkr2web_webp_take, (unsigned char *out, int cap),
{
	const decoder = globalThis.krkr2webImageDecoder;
	if (!decoder || !decoder.pending || !decoder.pending.rgba) return 0;
	const rgba = decoder.pending.rgba;
	decoder.pending = null;
	if (rgba.length > cap) return 0;
	HEAPU8.set(rgba, out);
	return rgba.length;
});

static bool Krkr2WebDecodeOffThread(bool bgra,
	const unsigned char *src, size_t len, int w, int h,
	unsigned char *out, size_t cap)
{
	const int packed = krkr2web_webp_request(bgra ? 1 : 0, src,
		(int)len, w, h);
	if(packed == 0) return false;
	const int copied = krkr2web_webp_take(out, (int)cap);
	return copied == (int)cap;
}
#endif

void TVPLoadWEBP(void *formatdata, void *callbackdata,
                 tTVPGraphicSizeCallback sizecallback,
                 tTVPGraphicScanLineCallback scanlinecallback,
                 tTVPMetaInfoPushCallback metainfopushcallback,
                 tTJSBinaryStream *src, tjs_int keyidx,
                 tTVPGraphicLoadMode mode) {
    WebPDecoderConfig config;
    if(WebPInitDecoderConfig(&config) == 0)
        TVPThrowExceptionMessage(TJS_W("Invalid WebP image"));

    int datasize = src->GetSize();
    std::unique_ptr<uint8_t[]> data(new uint8_t[datasize]);
    src->ReadBuffer(data.get(), datasize);
    if(WebPGetFeatures(data.get(), datasize, &config.input) != VP8_STATUS_OK)
        TVPThrowExceptionMessage(TJS_W("Invalid WebP image"));

    const int w = (int)config.input.width;
    const int h = (int)config.input.height;
    sizecallback(callbackdata, w, h);

    if(mode == glmNormal || mode == glmNormalRGBA) {
        const int stride = w * 4;
        std::unique_ptr<uint8_t[]> out(new uint8_t[stride * h]);
        // KRKR's normal 32-bit bitmap layout is BGRA. glmNormalRGBA is the
        // explicit RGBA exception used by callers that request channel order.
        bool decoded = false;
#ifdef __EMSCRIPTEN__
        decoded = Krkr2WebDecodeOffThread(mode != glmNormalRGBA,
            data.get(), (size_t)datasize, w, h, out.get(), (size_t)stride * h);
#endif
        if(!decoded) {
            config.output.colorspace =
                mode == glmNormalRGBA ? MODE_RGBA : MODE_BGRA;
            config.output.u.RGBA.rgba = out.get();
            config.output.u.RGBA.stride = stride;
            config.output.u.RGBA.size = stride * h;
            config.output.is_external_memory = 1;
            if(WebPDecode(data.get(), datasize, &config) != VP8_STATUS_OK)
                TVPThrowExceptionMessage(TJS_W("Invalid WebP image(RGBA mode)"));
        }

        for(int y = 0; y < h; y++) {
            void *scanline = scanlinecallback(callbackdata, y);
            if(!scanline) break;
            memcpy(scanline, out.get() + y * stride, stride);
            scanlinecallback(callbackdata, -1);
        }
    } else if(mode == glmGrayscale) {
        const int stride = w;
        std::unique_ptr<uint8_t[]> out(new uint8_t[stride * h]);
        const int uv_stride = (w + 1) / 2;
        const int uv_size = uv_stride * ((h + 1) / 2);
        std::unique_ptr<uint8_t[]> u(new uint8_t[uv_size]);
        std::unique_ptr<uint8_t[]> v(new uint8_t[uv_size]);
        config.output.colorspace = MODE_YUV;
        config.output.u.YUVA.y = out.get();
        config.output.u.YUVA.y_stride = stride;
        config.output.u.YUVA.y_size = stride * h;
        config.output.u.YUVA.u = u.get();
        config.output.u.YUVA.v = v.get();
        config.output.u.YUVA.u_stride = uv_stride;
        config.output.u.YUVA.v_stride = uv_stride;
        config.output.u.YUVA.u_size = uv_size;
        config.output.u.YUVA.v_size = uv_size;
        config.output.u.YUVA.a = nullptr;
        config.output.u.YUVA.a_stride = 0;
        config.output.u.YUVA.a_size = 0;
        config.output.is_external_memory = 1;
        if(WebPDecode(data.get(), datasize, &config) != VP8_STATUS_OK)
            TVPThrowExceptionMessage(TJS_W("Invalid WebP image(Grayscale Mode)"));

        for(int y = 0; y < h; y++) {
            void *scanline = scanlinecallback(callbackdata, y);
            if(!scanline) break;
            memcpy(scanline, out.get() + y * stride, stride);
            scanlinecallback(callbackdata, -1);
        }
    } else {
        TVPThrowExceptionMessage(TJS_W("WebP does not support palettized image"));
    }
}

void TVPLoadHeaderWEBP(void *formatdata, tTJSBinaryStream *src,
                       iTJSDispatch2 **dic) {
    WebPDecoderConfig config;
    if(WebPInitDecoderConfig(&config) == 0)
        TVPThrowExceptionMessage(TJS_W("Invalid WebP image"));

    int datasize = src->GetSize();
    std::unique_ptr<uint8_t[]> data(new uint8_t[datasize]);
    src->ReadBuffer(data.get(), datasize);
    if(WebPGetFeatures(data.get(), datasize, &config.input) != VP8_STATUS_OK)
        TVPThrowExceptionMessage(TJS_W("Invalid WebP image"));

    *dic = TJSCreateDictionaryObject();
    tTJSVariant val((tjs_int32)config.input.width);
    (*dic)->PropSet(TJS_MEMBERENSURE, TJS_W("width"), nullptr, &val, (*dic));
    val = tTJSVariant((tjs_int32)config.input.height);
    (*dic)->PropSet(TJS_MEMBERENSURE, TJS_W("height"), nullptr, &val, (*dic));
    val = tTJSVariant(config.input.has_alpha ? 32 : 24);
    (*dic)->PropSet(TJS_MEMBERENSURE, TJS_W("bpp"), nullptr, &val, (*dic));
}
