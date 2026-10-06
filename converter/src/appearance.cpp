#include "appearance.hpp"

#include <Quantity_Color.hxx>

#include <cmath>
#include <cstdio>

namespace {

// Python's round(): to the nearest integer, ties to even.
int roundHalfEven(double value) {
  double rounded = std::round(value);
  if (std::fabs(value - rounded) == 0.5) rounded = 2.0 * std::round(value / 2.0);
  return static_cast<int>(rounded);
}

} // namespace

int Appearances::add(const Quantity_ColorRGBA& colour) {
  // Quantity_Color stores linear RGB; the manifest, like Fusion's, stores sRGB bytes.
  double r, g, b;
  colour.GetRGB().Values(r, g, b, Quantity_TOC_sRGB);
  Appearance appearance{{}, roundHalfEven(r * 255), roundHalfEven(g * 255), roundHalfEven(b * 255), true};
  const double alpha = colour.Alpha();
  char name[64];
  if (alpha >= 0.999) {
    std::snprintf(name, sizeof name, "rgb(%d,%d,%d)", appearance.r, appearance.g, appearance.b);
  } else {
    appearance.opaque = false;
    std::snprintf(name, sizeof name, "rgba(%d,%d,%d,%.2f)", appearance.r, appearance.g, appearance.b, alpha);
  }
  appearance.name = name;
  auto found = index_.find(appearance.name);
  if (found != index_.end()) return found->second;
  const int index = static_cast<int>(list_.size());
  index_.emplace(appearance.name, index);
  list_.push_back(std::move(appearance));
  return index;
}

void Appearances::clear() {
  list_.clear();
  index_.clear();
}
