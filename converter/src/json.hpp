// A JSON writer that appends straight to a std::string: no tree, no allocation per value.
#pragma once

#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <string_view>
#include <vector>

class JsonWriter {
public:
  explicit JsonWriter(std::string& out) : out_(out) {}

  void beginObject() {
    separate();
    out_ += '{';
    first_.push_back(true);
  }
  void endObject() {
    out_ += '}';
    first_.pop_back();
  }
  void beginArray() {
    separate();
    out_ += '[';
    first_.push_back(true);
  }
  void endArray() {
    out_ += ']';
    first_.pop_back();
  }
  void key(std::string_view name) {
    separate();
    quoted(name);
    out_ += ':';
    afterKey_ = true;
  }
  void value(std::string_view text) {
    separate();
    quoted(text);
  }
  void value(const char* text) { value(std::string_view(text)); }
  void value(bool flag) {
    separate();
    out_ += flag ? "true" : "false";
  }
  void value(int32_t number) {
    separate();
    char buf[16];
    auto end = std::to_chars(buf, buf + sizeof buf, number).ptr;
    out_.append(buf, end);
  }
  // The shortest decimal that reads back to the same double. NaN and infinities are not JSON: they become null and
  // are counted, so the caller can warn once.
  void value(double number) {
    separate();
    if (!std::isfinite(number)) {
      ++nonFinite_;
      out_ += "null";
      return;
    }
    char buf[32];
    auto end = std::to_chars(buf, buf + sizeof buf, number).ptr;
    out_.append(buf, end);
  }
  void null() {
    separate();
    out_ += "null";
  }
  // A value serialised apart, such as a record built in its own buffer.
  void raw(std::string_view json) {
    separate();
    out_ += json;
  }
  int nonFinite() const { return nonFinite_; }

private:
  void separate() {
    if (afterKey_) {
      afterKey_ = false;
      return;
    }
    if (first_.empty()) return;
    if (!first_.back()) out_ += ',';
    first_.back() = false;
  }
  void quoted(std::string_view text) {
    out_ += '"';
    for (unsigned char c : text) {
      switch (c) {
      case '"': out_ += "\\\""; break;
      case '\\': out_ += "\\\\"; break;
      case '\n': out_ += "\\n"; break;
      case '\r': out_ += "\\r"; break;
      case '\t': out_ += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out_ += buf;
        } else {
          out_ += static_cast<char>(c);
        }
      }
    }
    out_ += '"';
  }

  std::string& out_;
  std::vector<bool> first_;
  bool afterKey_ = false;
  int nonFinite_ = 0;
};
