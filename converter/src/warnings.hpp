// Warnings collected during a call, handed to the host by conv_warnings.
#pragma once

#include <string>
#include <utility>
#include <vector>

class Warnings {
public:
  void add(std::string text) { list_.push_back(std::move(text)); }
  std::vector<std::string> take() { return std::exchange(list_, {}); }

private:
  std::vector<std::string> list_;
};
