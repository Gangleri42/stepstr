// conv_geometry: the exact geometry of one solid's vertices, edges and faces, as the Measure tool reads it.
#pragma once

#include <cstdint>
#include <string>

#include "converter.hpp"

// Appends the solid's record, or null when it has more faces than the limit (0: no limit), to out.
void writeGeometry(Solid& solid, int32_t faceLimit, Warnings& warnings, std::string& out);
