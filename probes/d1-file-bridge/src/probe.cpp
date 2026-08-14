#include <cstddef>
#include <cstdint>
#include <cstdlib>

#include <emscripten/emscripten.h>

namespace {

constexpr std::uint64_t kChunkSize = 4ULL * 1024ULL * 1024ULL;
constexpr std::uint64_t kLogicalFileSize = 5ULL * 1024ULL * 1024ULL * 1024ULL + 12345ULL;
constexpr std::uint32_t kMaximumRead = 64U * 1024U;
constexpr std::uint32_t kRandomReadCount = 10000U;

constexpr int kErrorRange = -1;
constexpr int kErrorChunkMissing = -2;
constexpr int kErrorStorage = -3;
constexpr int kErrorCancelled = -4;
constexpr int kErrorInvalidHandle = -5;

constexpr std::uint32_t kPassOpenSize = 1U << 0U;
constexpr std::uint32_t kPassLowOffset = 1U << 1U;
constexpr std::uint32_t kPassOver2GiB = 1U << 2U;
constexpr std::uint32_t kPassOver4GiB = 1U << 3U;
constexpr std::uint32_t kPassCrossBlock = 1U << 4U;
constexpr std::uint32_t kPassEndOfFile = 1U << 5U;
constexpr std::uint32_t kPassMissingBlock = 1U << 6U;
constexpr std::uint32_t kPassStorageError = 1U << 7U;
constexpr std::uint32_t kPassCancellation = 1U << 8U;
constexpr std::uint32_t kPassRandomReads = 1U << 9U;
constexpr std::uint32_t kPassClose = 1U << 10U;
constexpr std::uint32_t kAllPasses = (1U << 11U) - 1U;

std::uint32_t g_pass_mask = 0;
std::uint32_t g_random_reads = 0;
std::uint64_t g_verified_bytes = 0;
std::uint64_t g_background_verified_bytes = 0;
std::uint64_t g_soak_verified_bytes = 0;
std::uint32_t g_soak_reads = 0;
int g_last_error = 0;
bool g_handle_open = false;

EM_ASYNC_JS(int, d1_async_read,
            (std::uint32_t handle, std::uint64_t offset, std::uint32_t length,
             std::uint8_t* destination), {
    return await Module.d1Storage.readToHeap(
        handle, Number(offset), length, destination, HEAPU8);
});

EM_JS(void, d1_set_failure_mode, (int mode), {
    Module.d1Storage.setFailureMode(mode);
});

EM_JS(void, d1_report_progress, (std::uint32_t completed, std::uint32_t total), {
    Module.d1Storage.reportProgress(completed, total);
});

EM_ASYNC_JS(int, d1_async_wait_for_background, (), {
    return await Module.d1Storage.waitForBackgroundResume();
});

std::uint32_t expected_byte(std::uint64_t offset) {
    const std::uint64_t chunk_index = offset / kChunkSize;
    const std::uint32_t in_chunk = static_cast<std::uint32_t>(offset % kChunkSize);
    return static_cast<std::uint32_t>(
        (chunk_index * 29ULL + static_cast<std::uint64_t>(in_chunk) * 17ULL +
         static_cast<std::uint64_t>(in_chunk >> 8U) * 13ULL) &
        0xffULL);
}

int virtual_open() {
    g_handle_open = true;
    return 1;
}

std::uint64_t virtual_size(int handle) {
    return g_handle_open && handle == 1 ? kLogicalFileSize : 0;
}

int virtual_read(int handle, std::uint64_t offset, std::uint32_t length,
                 std::uint8_t* destination) {
    if (!g_handle_open || handle != 1) {
        return kErrorInvalidHandle;
    }
    if (length > kMaximumRead || offset > kLogicalFileSize) {
        return kErrorRange;
    }
    return d1_async_read(static_cast<std::uint32_t>(handle), offset, length, destination);
}

void virtual_close(int handle) {
    if (handle == 1) {
        g_handle_open = false;
    }
}

bool verify_bytes(const std::uint8_t* bytes, std::uint64_t offset,
                  std::uint32_t length) {
    for (std::uint32_t index = 0; index < length; ++index) {
        if (bytes[index] != expected_byte(offset + index)) {
            return false;
        }
    }
    g_verified_bytes += length;
    return true;
}

bool read_and_verify(int handle, std::uint64_t offset, std::uint32_t length,
                     std::uint8_t* buffer, std::uint32_t expected_length) {
    const int result = virtual_read(handle, offset, length, buffer);
    if (result != static_cast<int>(expected_length)) {
        g_last_error = result;
        return false;
    }
    if (!verify_bytes(buffer, offset, expected_length)) {
        g_last_error = -100;
        return false;
    }
    return true;
}

std::uint32_t next_random(std::uint32_t& state) {
    state ^= state << 13U;
    state ^= state >> 17U;
    state ^= state << 5U;
    return state;
}

bool run_random_reads(int handle, std::uint8_t* buffer) {
    constexpr std::uint32_t cold_chunks[] = {0U, 1U, 2U, 511U, 512U,
                                              513U, 1023U, 1024U, 1025U};
    constexpr std::uint32_t hot_chunks[] = {511U, 512U, 1023U, 1024U};
    constexpr std::uint32_t lengths[] = {64U, 512U, 4096U, 16384U, 65536U};
    std::uint32_t random_state = 0x5a17c9e3U;

    for (std::uint32_t index = 0; index < kRandomReadCount; ++index) {
        const std::uint32_t chunk = index < 128U
                                        ? cold_chunks[index % 9U]
                                        : hot_chunks[next_random(random_state) % 4U];
        const std::uint32_t length = lengths[next_random(random_state) % 5U];
        const std::uint32_t available = static_cast<std::uint32_t>(kChunkSize) - length;
        const std::uint32_t in_chunk = next_random(random_state) % (available + 1U);
        const std::uint64_t offset = static_cast<std::uint64_t>(chunk) * kChunkSize + in_chunk;
        if (!read_and_verify(handle, offset, length, buffer, length)) {
            return false;
        }
        g_random_reads = index + 1U;
        if ((g_random_reads % 250U) == 0U) {
            d1_report_progress(g_random_reads, kRandomReadCount);
        }
    }
    return true;
}

bool run_stability_reads(int handle, std::uint8_t* buffer, std::uint32_t seed,
                         std::uint32_t count) {
    constexpr std::uint32_t cold_chunks[] = {0U, 1U, 2U, 511U, 512U,
                                              513U, 1023U, 1024U, 1025U};
    constexpr std::uint32_t hot_chunks[] = {511U, 512U, 1023U, 1024U};
    constexpr std::uint32_t lengths[] = {512U, 4096U, 16384U, 65536U};
    std::uint32_t random_state = seed == 0 ? 0x71c93ad5U : seed;

    for (std::uint32_t index = 0; index < count; ++index) {
        const std::uint32_t chunk = (index % 20U) == 0U
                                        ? cold_chunks[next_random(random_state) % 9U]
                                        : hot_chunks[next_random(random_state) % 4U];
        const std::uint32_t length = lengths[next_random(random_state) % 4U];
        const std::uint32_t available = static_cast<std::uint32_t>(kChunkSize) - length;
        const std::uint32_t in_chunk = next_random(random_state) % (available + 1U);
        const std::uint64_t offset = static_cast<std::uint64_t>(chunk) * kChunkSize + in_chunk;
        const std::uint64_t before = g_verified_bytes;
        if (!read_and_verify(handle, offset, length, buffer, length)) {
            return false;
        }
        g_soak_verified_bytes += g_verified_bytes - before;
        g_soak_reads += 1U;
    }
    return true;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE int d1_run_suite() {
    g_pass_mask = 0;
    g_random_reads = 0;
    g_verified_bytes = 0;
    g_last_error = 0;
    g_handle_open = false;

    auto* buffer = static_cast<std::uint8_t*>(std::malloc(kMaximumRead));
    if (buffer == nullptr) {
        g_last_error = -101;
        return 0;
    }

    const int handle = virtual_open();
    if (handle == 1 && virtual_size(handle) == kLogicalFileSize) {
        g_pass_mask |= kPassOpenSize;
    }

    if (read_and_verify(handle, 12345ULL, 4096U, buffer, 4096U)) {
        g_pass_mask |= kPassLowOffset;
    }

    const std::uint64_t over_2_gib = 512ULL * kChunkSize + 991ULL;
    if (read_and_verify(handle, over_2_gib, 16384U, buffer, 16384U)) {
        g_pass_mask |= kPassOver2GiB;
    }

    const std::uint64_t over_4_gib = 1024ULL * kChunkSize + 1777ULL;
    if (read_and_verify(handle, over_4_gib, 16384U, buffer, 16384U)) {
        g_pass_mask |= kPassOver4GiB;
    }

    const std::uint64_t cross_2_gib = 512ULL * kChunkSize - 2048ULL;
    const std::uint64_t cross_4_gib = 1024ULL * kChunkSize - 2048ULL;
    if (read_and_verify(handle, cross_2_gib, 8192U, buffer, 8192U) &&
        read_and_verify(handle, cross_4_gib, 8192U, buffer, 8192U)) {
        g_pass_mask |= kPassCrossBlock;
    }

    if (read_and_verify(handle, kLogicalFileSize - 512ULL, 4096U, buffer, 512U)) {
        g_pass_mask |= kPassEndOfFile;
    }

    const int missing_result =
        virtual_read(handle, 700ULL * kChunkSize + 10ULL, 64U, buffer);
    if (missing_result == kErrorChunkMissing) {
        g_pass_mask |= kPassMissingBlock;
    } else {
        g_last_error = missing_result;
    }

    d1_set_failure_mode(1);
    const int storage_result = virtual_read(handle, 12345ULL, 64U, buffer);
    if (storage_result == kErrorStorage) {
        g_pass_mask |= kPassStorageError;
    } else {
        g_last_error = storage_result;
    }

    d1_set_failure_mode(2);
    const int cancel_result = virtual_read(handle, 12345ULL, 64U, buffer);
    if (cancel_result == kErrorCancelled) {
        g_pass_mask |= kPassCancellation;
    } else {
        g_last_error = cancel_result;
    }

    if (run_random_reads(handle, buffer)) {
        g_pass_mask |= kPassRandomReads;
    }

    virtual_close(handle);
    if (virtual_read(handle, 0, 64U, buffer) == kErrorInvalidHandle) {
        g_pass_mask |= kPassClose;
    }

    std::free(buffer);
    return g_pass_mask == kAllPasses ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int d1_run_background_suite() {
    g_background_verified_bytes = 0;
    g_last_error = 0;
    g_handle_open = false;

    if (d1_async_wait_for_background() != 1) {
        g_last_error = -102;
        return 0;
    }

    auto* buffer = static_cast<std::uint8_t*>(std::malloc(kMaximumRead));
    if (buffer == nullptr) {
        g_last_error = -101;
        return 0;
    }
    const int handle = virtual_open();
    const std::uint64_t before = g_verified_bytes;
    const bool passed =
        read_and_verify(handle, 1024ULL * kChunkSize + 8191ULL, 65536U, buffer, 65536U) &&
        read_and_verify(handle, 512ULL * kChunkSize - 4096ULL, 16384U, buffer, 16384U);
    g_background_verified_bytes = g_verified_bytes - before;
    virtual_close(handle);
    std::free(buffer);
    return passed ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE int d1_run_soak_batch(std::uint32_t seed, std::uint32_t count) {
    if (count == 0U || count > 200U) {
        g_last_error = kErrorRange;
        return 0;
    }
    auto* buffer = static_cast<std::uint8_t*>(std::malloc(kMaximumRead));
    if (buffer == nullptr) {
        g_last_error = -101;
        return 0;
    }
    const int handle = virtual_open();
    const bool passed = run_stability_reads(handle, buffer, seed, count);
    virtual_close(handle);
    std::free(buffer);
    return passed ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void d1_reset_soak_counters() {
    g_soak_reads = 0;
    g_soak_verified_bytes = 0;
    g_last_error = 0;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t d1_pass_mask() {
    return g_pass_mask;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t d1_expected_pass_mask() {
    return kAllPasses;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t d1_random_reads() {
    return g_random_reads;
}

EMSCRIPTEN_KEEPALIVE std::uint64_t d1_verified_bytes() {
    return g_verified_bytes;
}

EMSCRIPTEN_KEEPALIVE std::uint64_t d1_logical_file_size() {
    return kLogicalFileSize;
}

EMSCRIPTEN_KEEPALIVE int d1_last_error() {
    return g_last_error;
}

EMSCRIPTEN_KEEPALIVE std::uint64_t d1_background_verified_bytes() {
    return g_background_verified_bytes;
}

EMSCRIPTEN_KEEPALIVE std::uint32_t d1_soak_reads() {
    return g_soak_reads;
}

EMSCRIPTEN_KEEPALIVE std::uint64_t d1_soak_verified_bytes() {
    return g_soak_verified_bytes;
}

}  // extern "C"
