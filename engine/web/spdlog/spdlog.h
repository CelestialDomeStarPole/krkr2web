#pragma once
// Minimal header-only spdlog stub for the web plugin build. The krkr2 plugins
// only use spdlog::get(name) + logger->warn/info/error as diagnostics; the
// real library and fmt are not needed on the web target. Kept C++11 so the
// plugin sources do not need C++17.
#include <memory>
#include <string>

namespace spdlog {

namespace level {
enum level_enum { trace, debug, info, warn, err, critical, off, n_levels };
}

class logger {
public:
    logger() = default;
    explicit logger(std::string) {}
    template <typename... Args> void trace(Args&&...) noexcept {}
    template <typename... Args> void debug(Args&&...) noexcept {}
    template <typename... Args> void info(Args&&...) noexcept {}
    template <typename... Args> void warn(Args&&...) noexcept {}
    template <typename... Args> void error(Args&&...) noexcept {}
    template <typename... Args> void critical(Args&&...) noexcept {}
    template <typename... Args> void log(Args&&...) noexcept {}
    void set_level(level::level_enum) noexcept {}
    void flush() noexcept {}
};

inline std::shared_ptr<logger> get(const std::string &) {
    static auto instance = std::make_shared<logger>();
    return instance;
}

} // namespace spdlog
