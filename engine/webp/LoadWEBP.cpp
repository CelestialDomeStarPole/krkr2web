#include <webp/decode.h>
#include "tjsCommHead.h"
#include "GraphicsLoaderIntf.h"
#include "MsgIntf.h"
#include "tjsDictionary.h"
#include <memory>
#include <cstring>

// WebP graphic loader adapted for krkrsdl2's graphic loader API (3-arg size
// callback + per-scanline scanline callback). Original: kirikiroid2-web LoadWEBP.cpp.

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
        config.output.colorspace = MODE_RGBA;
        config.output.u.RGBA.rgba = out.get();
        config.output.u.RGBA.stride = stride;
        config.output.u.RGBA.size = stride * h;
        config.output.is_external_memory = 1;
        if(WebPDecode(data.get(), datasize, &config) != VP8_STATUS_OK)
            TVPThrowExceptionMessage(TJS_W("Invalid WebP image(RGBA mode)"));

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
