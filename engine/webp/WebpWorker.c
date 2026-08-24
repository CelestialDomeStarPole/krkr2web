// krkr2web: standalone libwebp decoder entry points for the page's WebP
// decode worker (apps/web/play/prefetch.js).
//
// WebView kernels without OffscreenCanvas inside workers (field data:
// TBS 046299 / Chrome 89 on a TB-X802F tablet) cannot read decoded pixels
// back through a canvas, so the worker's browser-native path
// (createImageBitmap + canvas readback) is unavailable. Until now those
// decodes fell back onto the page's MAIN thread (field report:
// mainDecodes 182 per session), each blocking long enough to starve the
// OpenAL scheduler and cut dialogue voices.
//
// This shim is compiled by tools/build_d3.ps1 into a tiny separate wasm
// module (webp-worker.js/.wasm) from the very same libwebp sources the
// engine links (generic C, no SIMD, no threads). The decode worker loads it
// via importScripts and decodes without any canvas API - the main thread
// only pays the final memcpy.

#include <webp/decode.h>
#include <webp/types.h>
#include <stdlib.h>

#if defined(__cplusplus)
extern "C" {
#endif

// Result block handed back to JS. The pixel buffer is malloc'd by libwebp;
// release it with krkr2web_webp_free, the block itself with free().
typedef struct
{
	int W;
	int H;
	unsigned char *RGBA;
} krkr2web_webp_result;

// Decodes a WebP bitstream into top-down RGBA (the same layout the worker's
// canvas readback produces). Returns NULL when the bitstream is invalid.
krkr2web_webp_result *krkr2web_webp_decode(const unsigned char *data, int len)
{
	if(!data || len <= 0) return NULL;
	int w = 0, h = 0;
	unsigned char *rgba = WebPDecodeRGBA(data, (size_t)len, &w, &h);
	if(!rgba || w <= 0 || h <= 0)
	{
		if(rgba) WebPFree(rgba);
		return NULL;
	}
	krkr2web_webp_result *result = (krkr2web_webp_result *)malloc(sizeof(*result));
	if(!result)
	{
		WebPFree(rgba);
		return NULL;
	}
	result->W = w;
	result->H = h;
	result->RGBA = rgba;
	return result;
}

void krkr2web_webp_free(void *ptr)
{
	WebPFree(ptr);
}

#if defined(__cplusplus)
}
#endif
