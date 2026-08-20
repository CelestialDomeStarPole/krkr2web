#include "tjsCommHead.h"
#include "LayerBitmapIntf.h"
#include "LayerBitmapImpl.h"
#include "DrawDeviceD3DIntf.h"
#include "RenderManager.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <unordered_map>
#include <utility>
#include <vector>

void TVPReverseRGB(tjs_uint32 *dest, const tjs_uint32 *src, tjs_int len) {
    for(tjs_int i = 0; i < len; ++i) {
        const tjs_uint32 pixel = src[i];
        dest[i] = (pixel & 0xff00ff00u) | ((pixel & 0x00ff0000u) >> 16) |
            ((pixel & 0x000000ffu) << 16);
    }
}

void iTVPTexture2D::Release() {
    if(--RefCount == 0)
        delete this;
}

void iTVPTexture2D::RecycleProcess() {}
void iTVPRenderManager::RegisterRenderMethod(const char *,
                                             iTVPRenderMethod *) {}
void iTVPRenderManager::Initialize() {}
iTVPRenderMethod *iTVPRenderManager::GetRenderMethod(const char *, uint32_t *) {
    return nullptr;
}
iTVPRenderMethod *iTVPRenderManager::CompileRenderMethod(
    const char *, const char *, int, unsigned int) {
    return nullptr;
}
iTVPRenderMethod *iTVPRenderManager::GetOrCompileRenderMethod(
    const char *name, uint32_t *hint, const char *, int, unsigned int) {
    return GetRenderMethod(name, hint);
}

namespace {

constexpr int kColorParameter = 0;
constexpr int kOpacityParameter = 1;
constexpr int kAlphaThresholdParameter = 2;
uint64_t OwnedTextureBytes = 0;

int pixelBytes(TVPTextureFormat::e format) {
    switch(format) {
        case TVPTextureFormat::Gray: return 1;
        case TVPTextureFormat::RGB: return 3;
        case TVPTextureFormat::RGBA: return 4;
        default: return 0;
    }
}

uint32_t decodePixel(const std::uint8_t *pixel, TVPTextureFormat::e format) {
    if(!pixel)
        return 0;
    if(format == TVPTextureFormat::Gray)
        return (static_cast<uint32_t>(pixel[0]) << 24) | 0x00ffffffu;
    if(format == TVPTextureFormat::RGB)
        return 0xff000000u | (static_cast<uint32_t>(pixel[2]) << 16) |
            (static_cast<uint32_t>(pixel[1]) << 8) | pixel[0];
    uint32_t value = 0;
    std::memcpy(&value, pixel, sizeof(value));
    return value;
}

void encodePixel(std::uint8_t *pixel, TVPTextureFormat::e format,
                 uint32_t value) {
    if(format == TVPTextureFormat::Gray) {
        pixel[0] = static_cast<std::uint8_t>(value >> 24);
    } else if(format == TVPTextureFormat::RGB) {
        pixel[0] = static_cast<std::uint8_t>(value);
        pixel[1] = static_cast<std::uint8_t>(value >> 8);
        pixel[2] = static_cast<std::uint8_t>(value >> 16);
    } else {
        std::memcpy(pixel, &value, sizeof(value));
    }
}

class WebMotionTexture final : public iTVPTexture2D {
public:
    WebMotionTexture(unsigned int width, unsigned int height,
                     TVPTextureFormat::e format) :
        iTVPTexture2D(width, height), Format(format) {
        allocate(width, height);
    }

    WebMotionTexture(const void *pixels, int pitch, unsigned int width,
                     unsigned int height, TVPTextureFormat::e format) :
        iTVPTexture2D(width, height), Format(format) {
        allocate(width, height);
        if(!Pixels || !pixels)
            return;
        const int rowBytes = static_cast<int>(width) * pixelBytes(format);
        const int sourcePitch = pitch ? pitch : rowBytes;
        const auto *source = static_cast<const std::uint8_t *>(pixels);
        for(unsigned int y = 0; y < height; ++y) {
            std::memcpy(Storage.data() + static_cast<size_t>(Pitch) * y,
                        source + static_cast<std::ptrdiff_t>(sourcePitch) * y,
                        static_cast<size_t>(rowBytes));
        }
    }

    explicit WebMotionTexture(tTVPBitmap *bitmap) :
        iTVPTexture2D(bitmap ? bitmap->GetWidth() : 0,
                      bitmap ? bitmap->GetHeight() : 0),
        Format(bitmap && bitmap->Is8bit() ? TVPTextureFormat::Gray
                                          : TVPTextureFormat::RGBA),
        Pitch(bitmap ? bitmap->GetPitch() : 0), Static(true), Bitmap(bitmap) {
        if(Bitmap)
            Bitmap->AddRef();
    }

    ~WebMotionTexture() override {
        unaccount();
        if(Bitmap)
            Bitmap->Release();
    }

    TVPTextureFormat::e GetFormat() const override { return Format; }
    tjs_int GetPitch() const override { return Pitch; }
    bool IsStatic() override { return Static; }
    bool IsOpaque() override { return false; }

    const void *GetScanLineForRead(tjs_uint y) override {
        if(y >= static_cast<tjs_uint>(Height))
            return nullptr;
        if(Bitmap)
            return Bitmap->GetScanLine(y);
        return Pixels
            ? Pixels + static_cast<std::ptrdiff_t>(Pitch) * y
            : nullptr;
    }

    void *GetScanLineForWrite(tjs_uint y) override {
        if(y >= static_cast<tjs_uint>(Height))
            return nullptr;
        if(Bitmap)
            return Bitmap->GetScanLine(y);
        return Pixels
            ? const_cast<std::uint8_t *>(Pixels) +
                static_cast<std::ptrdiff_t>(Pitch) * y
            : nullptr;
    }

    void SetSize(unsigned int width, unsigned int height) override {
        allocate(width, height);
    }

    void Update(const void *pixels, TVPTextureFormat::e format, int pitch,
                const tTVPRect &rect) override {
        if(rect.left < 0 || rect.top < 0 || rect.right > Width ||
           rect.bottom > Height || rect.left >= rect.right ||
           rect.top >= rect.bottom) {
            return;
        }
        ensureOwned();
        const int sourceBytes = pixelBytes(format);
        const int sourcePitch =
            pitch ? pitch : rect.get_width() * sourceBytes;
        const auto *source = static_cast<const std::uint8_t *>(pixels);
        for(int y = 0; y < rect.get_height(); ++y) {
            auto *destination = static_cast<std::uint8_t *>(
                GetScanLineForWrite(rect.top + y));
            for(int x = 0; x < rect.get_width(); ++x) {
                const uint32_t value = source
                    ? decodePixel(source +
                                      static_cast<std::ptrdiff_t>(sourcePitch) *
                                          y +
                                      x * sourceBytes,
                                  format)
                    : 0;
                encodePixel(destination +
                                (rect.left + x) * pixelBytes(Format),
                            Format, value);
            }
        }
    }

    uint32_t GetPoint(int x, int y) override {
        if(x < 0 || y < 0 || x >= Width || y >= Height)
            return 0;
        const auto *row = static_cast<const std::uint8_t *>(
            GetScanLineForRead(static_cast<tjs_uint>(y)));
        return decodePixel(row + x * pixelBytes(Format), Format);
    }

    void SetPoint(int x, int y, uint32_t value) override {
        if(x < 0 || y < 0 || x >= Width || y >= Height)
            return;
        ensureOwned();
        auto *row = static_cast<std::uint8_t *>(
            GetScanLineForWrite(static_cast<tjs_uint>(y)));
        encodePixel(row + x * pixelBytes(Format), Format, value);
    }

    cocos2d::Texture2D *
    GetAdapterTexture(cocos2d::Texture2D *) override {
        return nullptr;
    }

private:
    TVPTextureFormat::e Format;
    const std::uint8_t *Pixels = nullptr;
    int Pitch = 0;
    bool Static = false;
    tTVPBitmap *Bitmap = nullptr;
    std::vector<std::uint8_t> Storage;
    size_t AccountedBytes = 0;

    void unaccount() {
        if(AccountedBytes) {
            OwnedTextureBytes -= AccountedBytes;
            AccountedBytes = 0;
        }
    }

    void allocate(unsigned int width, unsigned int height) {
        unaccount();
        if(Bitmap) {
            Bitmap->Release();
            Bitmap = nullptr;
        }
        Width = static_cast<tjs_int>(width);
        Height = static_cast<tjs_int>(height);
        Static = false;
        const int bytes = pixelBytes(Format);
        if(bytes <= 0 || width == 0 || height == 0 ||
           width > static_cast<unsigned int>(
                       std::numeric_limits<int>::max() / bytes)) {
            Storage.clear();
            Pixels = nullptr;
            Pitch = 0;
            return;
        }
        Pitch = static_cast<int>(width) * bytes;
        Storage.assign(static_cast<size_t>(Pitch) * height, 0);
        Pixels = Storage.data();
        AccountedBytes = Storage.size();
        OwnedTextureBytes += AccountedBytes;
    }

    void ensureOwned() {
        if(!Static && !Bitmap)
            return;
        const unsigned int width = static_cast<unsigned int>(Width);
        const unsigned int height = static_cast<unsigned int>(Height);
        const int rowBytes = static_cast<int>(width) * pixelBytes(Format);
        std::vector<std::uint8_t> copy(static_cast<size_t>(rowBytes) * height);
        for(unsigned int y = 0; y < height; ++y) {
            const auto *row = static_cast<const std::uint8_t *>(
                GetScanLineForRead(y));
            if(row)
                std::memcpy(copy.data() + static_cast<size_t>(rowBytes) * y,
                            row, rowBytes);
        }
        allocate(width, height);
        if(!copy.empty())
            std::memcpy(Storage.data(), copy.data(), copy.size());
    }
};

class WebMotionMethod final : public iTVPRenderMethod {
public:
    WebMotionMethod(int method, int opacity, bool fill = false) :
        Method(method), Opacity(clampByte(opacity)),
        Color(fill ? 0u : 0xffffffffu), Fill(fill) {}

    int EnumParameterID(const char *name) override {
        if(!name)
            return -1;
        if(!std::strcmp(name, "color"))
            return kColorParameter;
        if(!std::strcmp(name, "opacity"))
            return kOpacityParameter;
        if(!std::strcmp(name, "alpha_threshold"))
            return kAlphaThresholdParameter;
        return -1;
    }
    void SetParameterUInt(int id, unsigned int value) override {
        set(id, static_cast<int>(value));
    }
    void SetParameterInt(int id, int value) override { set(id, value); }
    void SetParameterColor4B(int id, unsigned int value) override {
        if(id == kColorParameter)
            Color = value;
    }
    void SetParameterOpa(int id, int value) override { set(id, value); }

    int Method;
    int Opacity;
    int AlphaThreshold = 0;
    uint32_t Color;
    bool Fill;

private:
    static int clampByte(int value) {
        return std::max(0, std::min(255, value));
    }
    void set(int id, int value) {
        if(id == kColorParameter)
            Color = static_cast<unsigned int>(value);
        else if(id == kOpacityParameter)
            Opacity = clampByte(value);
        else if(id == kAlphaThresholdParameter)
            AlphaThreshold = clampByte(value);
    }
};

struct ReadSurface {
    const std::uint8_t *pixels = nullptr;
    int pitch = 0;
    int width = 0;
    int height = 0;
    TVPTextureFormat::e format = TVPTextureFormat::None;
};
struct WriteSurface {
    std::uint8_t *pixels = nullptr;
    int pitch = 0;
    int width = 0;
    int height = 0;
    TVPTextureFormat::e format = TVPTextureFormat::None;
};

ReadSurface readSurface(iTVPTexture2D *texture) {
    return texture
        ? ReadSurface{
              static_cast<const std::uint8_t *>(
                  texture->GetScanLineForRead(0)),
              texture->GetPitch(), static_cast<int>(texture->GetWidth()),
              static_cast<int>(texture->GetHeight()), texture->GetFormat() }
        : ReadSurface{};
}
WriteSurface writeSurface(iTVPTexture2D *texture) {
    return texture
        ? WriteSurface{
              static_cast<std::uint8_t *>(texture->GetScanLineForWrite(0)),
              texture->GetPitch(), static_cast<int>(texture->GetWidth()),
              static_cast<int>(texture->GetHeight()), texture->GetFormat() }
        : WriteSurface{};
}

uint32_t sample(const ReadSurface &surface, int x, int y) {
    x = std::max(0, std::min(surface.width - 1, x));
    y = std::max(0, std::min(surface.height - 1, y));
    return decodePixel(surface.pixels +
                           static_cast<std::ptrdiff_t>(surface.pitch) * y +
                           x * pixelBytes(surface.format),
                       surface.format);
}
uint32_t sample(const WriteSurface &surface, int x, int y) {
    return decodePixel(surface.pixels +
                           static_cast<std::ptrdiff_t>(surface.pitch) * y +
                           x * pixelBytes(surface.format),
                       surface.format);
}
void store(const WriteSurface &surface, int x, int y, uint32_t value) {
    encodePixel(surface.pixels +
                    static_cast<std::ptrdiff_t>(surface.pitch) * y +
                    x * pixelBytes(surface.format),
                surface.format, value);
}

int blendChannel(int destination, int source, int method) {
    switch(method) {
        case bmAdd:
        case bmPsAdditive: return std::min(255, destination + source);
        case bmSub:
        case bmPsSubtractive:
            return std::max(0, destination + source - 255);
        case bmMul:
        case bmPsMultiplicative:
            return (destination * source + 127) / 255;
        case bmScreen:
        case bmPsScreen:
            return 255 - ((255 - destination) * (255 - source) + 127) / 255;
        default: return source;
    }
}

uint32_t modulateMotionColor(uint32_t source, uint32_t color) {
    const auto multiply = [](uint32_t value, uint32_t scale) {
        return (value * scale + 127u) / 255u;
    };
    // TVP pixels are BGRA bytes (0xAARRGGBB), while Motion stores tint as
    // RGBA bytes (0xAABBGGRR). Match the native shader's channel semantics.
    const uint32_t blue = multiply(source & 0xffu, (color >> 16) & 0xffu);
    const uint32_t green =
        multiply((source >> 8) & 0xffu, (color >> 8) & 0xffu);
    const uint32_t red =
        multiply((source >> 16) & 0xffu, color & 0xffu);
    const uint32_t alpha =
        multiply((source >> 24) & 0xffu, (color >> 24) & 0xffu);
    return blue | (green << 8) | (red << 16) | (alpha << 24);
}

uint32_t composite(uint32_t destination, uint32_t source,
                   const WebMotionMethod *method) {
    if(method && method->Color != 0xffffffffu)
        source = modulateMotionColor(source, method->Color);
    if(method && method->Method == bmCopy && method->Opacity == 255 &&
       method->AlphaThreshold == 0)
        return source;
    const int sourceAlpha = static_cast<int>(source >> 24);
    if(method && sourceAlpha < method->AlphaThreshold)
        return destination;
    const int alpha =
        (sourceAlpha * (method ? method->Opacity : 255) + 127) / 255;
    if(alpha <= 0)
        return destination;
    const int blendMethod = method ? method->Method : bmAlpha;
    if(alpha >= 255 &&
       (blendMethod == bmAlpha || blendMethod == bmPsNormal ||
        blendMethod == bmCopy)) {
        return source;
    }
    const int inverseAlpha = 255 - alpha;
    uint32_t result = 0;
    for(int shift = 0; shift <= 16; shift += 8) {
        const int dst = (destination >> shift) & 0xff;
        const int src = (source >> shift) & 0xff;
        const int blended = blendChannel(dst, src, blendMethod);
        result |= static_cast<uint32_t>(
                      (blended * alpha + dst * inverseAlpha + 127) / 255)
            << shift;
    }
    const int destinationAlpha = destination >> 24;
    const int outputAlpha =
        alpha + (destinationAlpha * inverseAlpha + 127) / 255;
    return result | (static_cast<uint32_t>(outputAlpha) << 24);
}

void fill(const WriteSurface &target, const tTVPRect &input, uint32_t color) {
    const int left = std::max(0, input.left);
    const int top = std::max(0, input.top);
    const int right = std::min(target.width, input.right);
    const int bottom = std::min(target.height, input.bottom);
    if(color == 0 && target.format == TVPTextureFormat::RGBA) {
        for(int y = top; y < bottom; ++y) {
            std::memset(target.pixels +
                            static_cast<std::ptrdiff_t>(target.pitch) * y +
                            left * 4,
                        0, static_cast<size_t>(right - left) * 4);
        }
        return;
    }
    for(int y = top; y < bottom; ++y)
        for(int x = left; x < right; ++x)
            store(target, x, y, color);
}

void mappedRect(const WriteSurface &target, const ReadSurface &source,
                const tTVPRect &clip, double dx0, double dy0, double dx1,
                double dy1, double sx0, double sy0, double sx1, double sy1,
                const WebMotionMethod *method) {
    if(dx0 == dx1 || dy0 == dy1)
        return;
    const int left = std::max(
        { 0, clip.left,
          static_cast<int>(std::ceil(std::min(dx0, dx1) - 0.5)) });
    const int top = std::max(
        { 0, clip.top,
          static_cast<int>(std::ceil(std::min(dy0, dy1) - 0.5)) });
    const int right = std::min(
        { target.width, clip.right,
          static_cast<int>(std::ceil(std::max(dx0, dx1) - 0.5)) });
    const int bottom = std::min(
        { target.height, clip.bottom,
          static_cast<int>(std::ceil(std::max(dy0, dy1) - 0.5)) });
    const double stepX = (sx1 - sx0) / (dx1 - dx0);
    const double stepY = (sy1 - sy0) / (dy1 - dy0);
    for(int y = top; y < bottom; ++y) {
        const int sourceY = static_cast<int>(std::floor(
            sy0 + (y + 0.5 - dy0) * stepY));
        double sourceX = sx0 + (left + 0.5 - dx0) * stepX;
        for(int x = left; x < right; ++x, sourceX += stepX) {
            const uint32_t sourcePixel =
                sample(source, static_cast<int>(std::floor(sourceX)), sourceY);
            store(target, x, y,
                  composite(sample(target, x, y), sourcePixel, method));
        }
    }
}

double edge(const tTVPPointD &a, const tTVPPointD &b, double x, double y) {
    return (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
}
bool isTopLeft(const tTVPPointD &a, const tTVPPointD &b) {
    return b.y < a.y || (b.y == a.y && b.x > a.x);
}
bool insideEdge(double value, bool topLeft, double epsilon) {
    return value > epsilon || (std::abs(value) <= epsilon && topLeft);
}

void triangle(const WriteSurface &target, const ReadSurface &source,
              const tTVPRect &clip, const tTVPPointD *destinationInput,
              const tTVPPointD *textureInput, const WebMotionMethod *method) {
    tTVPPointD destination[3] = { destinationInput[0], destinationInput[1],
                                  destinationInput[2] };
    tTVPPointD texture[3] = { textureInput[0], textureInput[1],
                              textureInput[2] };
    double area = edge(destination[0], destination[1], destination[2].x,
                       destination[2].y);
    if(std::abs(area) < 1.0e-9)
        return;
    if(area < 0.0) {
        std::swap(destination[1], destination[2]);
        std::swap(texture[1], texture[2]);
        area = -area;
    }
    const double minX = std::min({ destination[0].x, destination[1].x,
                                   destination[2].x });
    const double maxX = std::max({ destination[0].x, destination[1].x,
                                   destination[2].x });
    const double minY = std::min({ destination[0].y, destination[1].y,
                                   destination[2].y });
    const double maxY = std::max({ destination[0].y, destination[1].y,
                                   destination[2].y });
    const int left = std::max(
        { 0, clip.left, static_cast<int>(std::ceil(minX - 0.5)) });
    const int top = std::max(
        { 0, clip.top, static_cast<int>(std::ceil(minY - 0.5)) });
    const int right = std::min(
        { target.width, clip.right,
          static_cast<int>(std::ceil(maxX - 0.5)) });
    const int bottom = std::min(
        { target.height, clip.bottom,
          static_cast<int>(std::ceil(maxY - 0.5)) });
    if(left >= right || top >= bottom)
        return;

    const double stepX[3] = {
        destination[1].y - destination[2].y,
        destination[2].y - destination[0].y,
        destination[0].y - destination[1].y
    };
    const double stepY[3] = {
        destination[2].x - destination[1].x,
        destination[0].x - destination[2].x,
        destination[1].x - destination[0].x
    };
    const bool topLeft[3] = {
        isTopLeft(destination[1], destination[2]),
        isTopLeft(destination[2], destination[0]),
        isTopLeft(destination[0], destination[1])
    };
    const double inverseArea = 1.0 / area;
    const double textureStepX =
        (stepX[0] * texture[0].x + stepX[1] * texture[1].x +
         stepX[2] * texture[2].x) *
        inverseArea;
    const double textureYStepX =
        (stepX[0] * texture[0].y + stepX[1] * texture[1].y +
         stepX[2] * texture[2].y) *
        inverseArea;
    const double epsilon = std::max(1.0e-9, area * 1.0e-12);
    double rowEdge[3] = {
        edge(destination[1], destination[2], left + 0.5, top + 0.5),
        edge(destination[2], destination[0], left + 0.5, top + 0.5),
        edge(destination[0], destination[1], left + 0.5, top + 0.5)
    };
    for(int y = top; y < bottom; ++y) {
        double values[3] = { rowEdge[0], rowEdge[1], rowEdge[2] };
        double textureX =
            (values[0] * texture[0].x + values[1] * texture[1].x +
             values[2] * texture[2].x) *
            inverseArea;
        double textureY =
            (values[0] * texture[0].y + values[1] * texture[1].y +
             values[2] * texture[2].y) *
            inverseArea;
        for(int x = left; x < right; ++x) {
            if(insideEdge(values[0], topLeft[0], epsilon) &&
               insideEdge(values[1], topLeft[1], epsilon) &&
               insideEdge(values[2], topLeft[2], epsilon)) {
                const uint32_t sourcePixel = sample(
                    source, static_cast<int>(std::floor(textureX)),
                    static_cast<int>(std::floor(textureY)));
                store(target, x, y,
                      composite(sample(target, x, y), sourcePixel, method));
            }
            for(int i = 0; i < 3; ++i)
                values[i] += stepX[i];
            textureX += textureStepX;
            textureY += textureYStepX;
        }
        for(int i = 0; i < 3; ++i)
            rowEdge[i] += stepY[i];
    }
}

bool equalPoint(double a, double b) { return std::abs(a - b) <= 1.0e-7; }
bool axisAlignedQuad(const tTVPPointD *p) {
    return equalPoint(p[1].x, p[3].x) && equalPoint(p[1].y, p[3].y) &&
        equalPoint(p[2].x, p[4].x) && equalPoint(p[2].y, p[4].y) &&
        equalPoint(p[0].y, p[1].y) && equalPoint(p[0].x, p[2].x) &&
        equalPoint(p[1].x, p[5].x) && equalPoint(p[2].y, p[5].y);
}

class WebMotionRenderManager final : public iTVPRenderManager {
public:
    iTVPTexture2D *CreateTexture2D(const void *pixels, int pitch,
                                   unsigned int width, unsigned int height,
                                   TVPTextureFormat::e format, int) override {
        if(pixelBytes(format) == 0)
            return nullptr;
        return pixels ? static_cast<iTVPTexture2D *>(new WebMotionTexture(
                            pixels, pitch, width, height, format))
                      : static_cast<iTVPTexture2D *>(
                            new WebMotionTexture(width, height, format));
    }
    iTVPTexture2D *CreateTexture2D(tTVPBitmap *bitmap) override {
        return bitmap ? new WebMotionTexture(bitmap) : nullptr;
    }
    iTVPTexture2D *CreateTexture2D(TJS::tTJSBinaryStream *) override {
        return nullptr;
    }
    iTVPTexture2D *CreateTexture2D(unsigned int width, unsigned int height,
                                   iTVPTexture2D *source) override {
        const auto format = source ? source->GetFormat()
                                   : TVPTextureFormat::RGBA;
        auto *result = new WebMotionTexture(width, height, format);
        if(source && source->GetScanLineForRead(0)) {
            result->Update(
                source->GetScanLineForRead(0), format, source->GetPitch(),
                tTVPRect(0, 0, std::min<int>(width, source->GetWidth()),
                         std::min<int>(height, source->GetHeight())));
        }
        return result;
    }

    iTVPRenderMethod *GetRenderMethod(const char *name, uint32_t *) override {
        if(!name)
            return nullptr;
        if(!std::strcmp(name, "FillARGB")) {
            if(!FillMethod)
                FillMethod.reset(new WebMotionMethod(bmCopy, 255, true));
            return FillMethod.get();
        }
        if(std::strstr(name, "AddBlend"))
            return method(255, false, bmPsAdditive);
        if(std::strstr(name, "SubBlend"))
            return method(255, false, bmPsSubtractive);
        if(std::strstr(name, "MulBlend"))
            return method(255, false, bmPsMultiplicative);
        if(std::strstr(name, "ScreenBlend"))
            return method(255, false, bmPsScreen);
        if(std::strstr(name, "Copy"))
            return method(255, false, bmCopy);
        if(std::strstr(name, "AlphaBlend"))
            return method(255, false, bmAlpha);
        return nullptr;
    }

    iTVPRenderMethod *method(int opacity, bool holdAlpha, int blendMethod) {
        opacity = std::max(0, std::min(255, opacity));
        const uint64_t key = (static_cast<uint64_t>(blendMethod + 1) << 10) |
            (static_cast<uint64_t>(opacity) << 1) | holdAlpha;
        auto &value = Methods[key];
        if(!value)
            value.reset(new WebMotionMethod(blendMethod, opacity));
        value->Color = 0xffffffffu;
        value->AlphaThreshold = 0;
        return value.get();
    }

    bool IsSoftware() override { return true; }
    const char *GetName() override { return "krkr2web-motion-batch-software"; }
    bool GetRenderStat(unsigned int &drawCount,
                       uint64_t &memorySize) override {
        drawCount = DrawCount;
        DrawCount = 0;
        memorySize = OwnedTextureBytes;
        return true;
    }
    bool GetTextureStat(iTVPTexture2D *texture,
                        uint64_t &memorySize) override {
        if(!texture) {
            memorySize = 0;
            return false;
        }
        memorySize = static_cast<uint64_t>(std::abs(texture->GetPitch())) *
            texture->GetHeight();
        return true;
    }

    void OperateRect(iTVPRenderMethod *renderMethod,
                     iTVPTexture2D *targetTexture, iTVPTexture2D *,
                     const tTVPRect &targetRect,
                     const tRenderTexRectArray &textures) override {
        ++DrawCount;
        const auto target = writeSurface(targetTexture);
        if(!target.pixels || !target.pitch)
            return;
        auto *webMethod = static_cast<WebMotionMethod *>(renderMethod);
        if(textures.size() == 0) {
            fill(target, targetRect,
                 webMethod && webMethod->Fill ? webMethod->Color : 0u);
            return;
        }
        const auto source = readSurface(textures[0].first);
        if(!source.pixels || !source.pitch)
            return;
        const auto &sourceRect = textures[0].second;
        mappedRect(target, source, targetRect, targetRect.left, targetRect.top,
                   targetRect.right, targetRect.bottom, sourceRect.left,
                   sourceRect.top, sourceRect.right, sourceRect.bottom,
                   webMethod);
    }

    void OperateTriangles(iTVPRenderMethod *renderMethod, int triangleCount,
                          iTVPTexture2D *targetTexture, iTVPTexture2D *,
                          const tTVPRect &clip,
                          const tTVPPointD *destination,
                          const tRenderTexQuadArray &textures) override {
        ++DrawCount;
        if(triangleCount <= 0 || !destination || textures.size() == 0 ||
           !textures[0].first || !textures[0].second)
            return;
        const auto target = writeSurface(targetTexture);
        const auto source = readSurface(textures[0].first);
        if(!target.pixels || !source.pixels || !target.pitch || !source.pitch)
            return;
        const auto *sourcePoints = textures[0].second;
        auto *webMethod = static_cast<WebMotionMethod *>(renderMethod);
        if(triangleCount == 2 && axisAlignedQuad(destination) &&
           axisAlignedQuad(sourcePoints)) {
            mappedRect(target, source, clip, destination[0].x,
                       destination[0].y, destination[5].x, destination[5].y,
                       sourcePoints[0].x, sourcePoints[0].y, sourcePoints[5].x,
                       sourcePoints[5].y, webMethod);
            return;
        }
        for(int i = 0; i < triangleCount; ++i)
            triangle(target, source, clip, destination + i * 3,
                     sourcePoints + i * 3, webMethod);
    }

    void OperatePerspective(iTVPRenderMethod *renderMethod, int quadCount,
                            iTVPTexture2D *targetTexture, iTVPTexture2D *,
                            const tTVPRect &clip,
                            const tTVPPointD *destination,
                            const tRenderTexQuadArray &textures) override {
        ++DrawCount;
        if(quadCount <= 0 || !destination || textures.size() == 0 ||
           !textures[0].first || !textures[0].second)
            return;
        const auto target = writeSurface(targetTexture);
        const auto source = readSurface(textures[0].first);
        if(!target.pixels || !source.pixels || !target.pitch || !source.pitch)
            return;
        const auto *sourcePoints = textures[0].second;
        auto *webMethod = static_cast<WebMotionMethod *>(renderMethod);
        static const int indices[6] = { 0, 1, 2, 1, 2, 3 };
        for(int quad = 0; quad < quadCount; ++quad) {
            tTVPPointD dst[6], src[6];
            for(int i = 0; i < 6; ++i) {
                dst[i] = destination[quad * 4 + indices[i]];
                src[i] = sourcePoints[quad * 4 + indices[i]];
            }
            triangle(target, source, clip, dst, src, webMethod);
            triangle(target, source, clip, dst + 3, src + 3, webMethod);
        }
    }

private:
    unsigned int DrawCount = 0;
    std::unordered_map<uint64_t, std::unique_ptr<WebMotionMethod>> Methods;
    std::unique_ptr<WebMotionMethod> FillMethod;
};

WebMotionRenderManager MotionRenderManager;

} // namespace

iTVPRenderMethod *
iTVPRenderManager::GetRenderMethod(tjs_int opacity, bool holdAlpha,
                                   int method) {
    return MotionRenderManager.method(opacity, holdAlpha, method);
}

void TVPRegisterRenderManager(const char *, iTVPRenderManager *(*)()) {}
iTVPRenderManager *TVPGetRenderManager() { return &MotionRenderManager; }
iTVPRenderManager *TVPGetRenderManager(const TJS::tTJSString &) {
    return &MotionRenderManager;
}
bool TVPIsSoftwareRenderManager() { return true; }

D3DLayerObject::~D3DLayerObject() { Listeners.clear(); }

iTVPTexture2D *D3DLayerObject::GetParentDrawTarget() const { return nullptr; }

void D3DLayerObject::AddListener(D3DLayerListener *listener) {
    if(listener)
        Listeners.push_back(listener);
}

void D3DLayerObject::RemoveListener(D3DLayerListener *listener) {
    if(listener)
        Listeners.remove(listener);
}

bool D3DLayerObject::OnUpdate(const tTJSVariant &) {
    bool visible = false;
    for(auto *listener : Listeners) {
        if(listener)
            visible = listener->IsVisible() || visible;
    }
    return visible;
}

void D3DLayerObject::setFrontIndex(tjs_int value) { FrontIndex = value; }
void D3DLayerObject::setBackIndex(tjs_int value) { BackIndex = value; }

D3DLayerObject *TVPGetD3DImageNative(iTJSDispatch2 *) { return nullptr; }
float TVPGetD3DImageScaleX(const D3DLayerObject *) { return 0.0f; }
