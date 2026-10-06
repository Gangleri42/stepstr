// The C ABI of converter.wasm (ABI.md). Every export catches every exception and returns an error code instead.
#include <Standard_Failure.hxx>
#include <Standard_OutOfMemory.hxx>

#include <cctype>
#include <cstdint>
#include <limits>
#include <new>
#include <stdexcept>
#include <string>
#include <typeinfo>

#include "converter.hpp"
#include "geometry.hpp"
#include "json.hpp"
#include "mesh.hpp"
#include "progress.hpp"

#define EXPORT extern "C" __attribute__((visibility("default")))

namespace {

constexpr int32_t kAbiVersion = 2;
// A result buffer past this size is freed after use rather than kept for the next call.
constexpr size_t kKeepCapacity = 16u << 20;

Converter converter;
std::string result;
std::string error;

void startCall() {
  if (result.capacity() > kKeepCapacity) std::string().swap(result);
  result.clear();
}

int32_t resultLength() {
  if (result.size() > static_cast<size_t>(std::numeric_limits<int32_t>::max())) {
    throw std::runtime_error("result larger than 2 GB");
  }
  return static_cast<int32_t>(result.size());
}

// The exception's class name, e.g. Standard_NullObject: typeid's mangled name without its length prefix.
std::string exceptionName(const std::exception& e) {
  const char* name = typeid(e).name();
  while (std::isdigit(static_cast<unsigned char>(*name))) ++name;
  return name;
}

template <class Body> int32_t guarded(Body&& body) {
  try {
    return body();
  } catch (const BadInput& e) {
    error = e.what();
    return -1;
  } catch (const Cancelled& e) {
    error = e.what();
    return -5;
  } catch (const Standard_OutOfMemory&) {
    error = "out of memory";
    return -3;
  } catch (const Standard_Failure& e) {
    error = exceptionName(e) + ": " + e.what();
    return -2;
  } catch (const std::bad_alloc&) {
    error = "out of memory";
    return -3;
  } catch (const std::exception& e) {
    error = e.what();
    return -4;
  } catch (...) {
    error = "unknown error";
    return -4;
  }
}

void requireDocument() {
  if (!converter.loaded()) throw BadInput("no document, call conv_transfer first");
}

} // namespace

EXPORT int32_t conv_abi() { return kAbiVersion; }

EXPORT int32_t conv_set_option(int32_t key, double value) {
  switch (key) {
  case 1: converter.options.healing = value != 0; return 0;
  case 2: converter.options.normals = value != 0; return 0;
  case 3:
    if (!(value >= 0) || value > std::numeric_limits<int32_t>::max()) {
      error = "geometry face limit out of range: " + std::to_string(value);
      return -1;
    }
    converter.options.geometryFaceLimit = static_cast<int32_t>(value);
    return 0;
  default: error = "unknown option " + std::to_string(key); return -1;
  }
}

EXPORT uint8_t* conv_alloc(uint32_t size) {
  try {
    startCall();
    return size ? converter.allocInput(size) : nullptr;
  } catch (...) {
    return nullptr;
  }
}

EXPORT int32_t conv_read() {
  return guarded([] {
    startCall();
    converter.read();
    return 0;
  });
}

EXPORT int32_t conv_transfer() {
  return guarded([] {
    startCall();
    return converter.transfer();
  });
}

EXPORT int32_t conv_tree() {
  return guarded([] {
    startCall();
    requireDocument();
    converter.writeTree(result);
    return resultLength();
  });
}

EXPORT int32_t conv_mesh(int32_t solid, double linear, double angular) {
  return guarded([=] {
    startCall();
    requireDocument();
    if (!(linear > 0) || !(angular > 0)) throw BadInput("deflections must be positive");
    writeMesh(converter.solid(solid), linear, angular, converter.options.normals, converter.appearances,
              converter.warnings, result);
    return resultLength();
  });
}

EXPORT int32_t conv_geometry(int32_t solid) {
  return guarded([=] {
    startCall();
    requireDocument();
    writeGeometry(converter.solid(solid), converter.options.geometryFaceLimit, converter.warnings, result);
    return resultLength();
  });
}

EXPORT int32_t conv_warnings() {
  return guarded([] {
    startCall();
    JsonWriter json(result);
    json.beginArray();
    for (const std::string& warning : converter.warnings.take()) json.value(warning);
    json.endArray();
    return resultLength();
  });
}

EXPORT int32_t conv_release(int32_t solid) {
  return guarded([=] {
    startCall();
    requireDocument();
    converter.release(solid);
    return 0;
  });
}

EXPORT int32_t conv_close() {
  return guarded([] {
    startCall();
    converter.close();
    return 0;
  });
}

EXPORT const char* conv_result_ptr() { return result.data(); }

EXPORT const char* conv_error() { return error.c_str(); }
