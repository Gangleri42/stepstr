// The manifest's colour table, with the names the oracle gives colours.
#pragma once

#include <Quantity_ColorRGBA.hxx>

#include <string>
#include <unordered_map>
#include <vector>

struct Appearance {
  std::string name; // rgb(r,g,b) or rgba(r,g,b,0.50)
  int r, g, b;      // sRGB bytes
  bool opaque;
};

class Appearances {
public:
  // The index of the colour's appearance, registering it on first sight.
  int add(const Quantity_ColorRGBA& colour);
  const std::vector<Appearance>& list() const { return list_; }
  void clear();

private:
  std::vector<Appearance> list_;
  std::unordered_map<std::string, int> index_;
};
