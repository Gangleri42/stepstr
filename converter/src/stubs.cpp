// Symbols that OpenCascade's file and host utilities reference but a converter reading from memory never uses.
// Defining them here keeps them out of the module's imports, so the loader implements WASI and nothing else.
// Each reports failure if a path ever calls it.
#include <cerrno>
#include <cstdint>

extern "C" {

int emscripten_get_callstack(int, char*, int) { return 0; }

uint32_t _emscripten_lookup_name(const char*) { return 0; }

int __syscall_chmod(intptr_t, int) { return -ENOSYS; }

int __syscall_faccessat(int, intptr_t, int, int) { return -ENOSYS; }

} // extern "C"
