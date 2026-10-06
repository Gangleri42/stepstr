// conv_mesh: one solid's triangulation in the ABI's binary layout.
#pragma once

#include <string>

#include "converter.hpp"

// Meshes the solid at the given deflections (mm, rad) and appends the result to out.
void writeMesh(Solid& solid, double linear, double angular, bool normals, const Appearances& appearances,
               Warnings& warnings, std::string& out);
