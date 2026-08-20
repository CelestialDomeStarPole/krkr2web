#pragma once

#include <sstream>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace fmt {

template <typename... Args>
using format_string = const char *;

namespace detail {

inline std::string format_value(const std::string &value) { return value; }
inline std::string format_value(const char *value) {
    return value ? std::string(value) : std::string("(null)");
}
inline std::string format_value(char *value) {
    return value ? std::string(value) : std::string("(null)");
}

template <typename T>
std::string format_value(T &&value) {
    std::ostringstream stream;
    stream << std::forward<T>(value);
    return stream.str();
}

inline std::string substitute(const std::string &pattern,
                              const std::vector<std::string> &values) {
    std::string output;
    output.reserve(pattern.size() + values.size() * 8);
    std::size_t value_index = 0;
    for(std::size_t i = 0; i < pattern.size();) {
        if(pattern[i] == '{' && i + 1 < pattern.size() &&
           pattern[i + 1] == '{') {
            output.push_back('{');
            i += 2;
            continue;
        }
        if(pattern[i] == '}' && i + 1 < pattern.size() &&
           pattern[i + 1] == '}') {
            output.push_back('}');
            i += 2;
            continue;
        }
        if(pattern[i] == '{') {
            const std::size_t end = pattern.find('}', i + 1);
            if(end != std::string::npos) {
                if(value_index < values.size()) output += values[value_index++];
                i = end + 1;
                continue;
            }
        }
        output.push_back(pattern[i++]);
    }
    return output;
}

} // namespace detail

template <typename... Args>
std::string format(const std::string &pattern, Args &&...args) {
    std::vector<std::string> values{
        detail::format_value(std::forward<Args>(args))...
    };
    return detail::substitute(pattern, values);
}

template <typename... Args>
std::string format(const char *pattern, Args &&...args) {
    return format(std::string(pattern ? pattern : ""),
                  std::forward<Args>(args)...);
}

} // namespace fmt
