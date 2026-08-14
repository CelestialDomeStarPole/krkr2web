#include <cstddef>
#include <cstdint>
#include <limits>

#include <emscripten/emscripten.h>
#include <emscripten/heap.h>

namespace {

constexpr std::uint64_t kOffsetProbe = 0x0000000180001001ULL;

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE int d0_core_self_test() {
    static_assert(sizeof(std::uint64_t) == 8, "uint64_t must be 64 bits");
    static_assert(sizeof(void*) == 4, "D0 requires wasm32 pointers");

    const std::uint64_t reconstructed =
        (static_cast<std::uint64_t>(0x00000001U) << 32U) | 0x80001001U;
    return reconstructed == kOffsetProbe &&
                   std::numeric_limits<std::uint64_t>::max() > reconstructed
               ? 1
               : 0;
}

EMSCRIPTEN_KEEPALIVE std::uint64_t d0_echo_u64(std::uint64_t value) {
    return value;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t d0_offset_high() {
    return static_cast<std::uint32_t>(kOffsetProbe >> 32U);
}

EMSCRIPTEN_KEEPALIVE std::uint32_t d0_offset_low() {
    return static_cast<std::uint32_t>(kOffsetProbe & 0xffffffffULL);
}

EMSCRIPTEN_KEEPALIVE std::uint32_t d0_pointer_bits() {
    return static_cast<std::uint32_t>(sizeof(void*) * 8U);
}

EMSCRIPTEN_KEEPALIVE std::uint32_t d0_heap_bytes() {
    return static_cast<std::uint32_t>(emscripten_get_heap_size());
}

}  // extern "C"
