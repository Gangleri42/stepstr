#include "progress.hpp"

#include <chrono>
#include <string>

extern "C" __attribute__((import_module("env"), import_name("conv_progress"))) int32_t conv_progress(int32_t phase,
                                                                                                   double done,
                                                                                                   double total);

namespace {

constexpr double kMinIntervalMillis = 5;

double nowMillis() {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

const char* phaseName(Phase phase) {
  switch (phase) {
  case Phase::read: return "read";
  case Phase::transfer: return "transfer";
  case Phase::mesh: return "mesh";
  case Phase::geometry: return "geometry";
  }
  return "?";
}

} // namespace

Cancelled::Cancelled(Phase phase) : runtime_error(std::string("cancelled during ") + phaseName(phase)) {}

Progress::Progress(Phase phase, double occtShare) : phase_(phase), occtShare_(occtShare) {
  send(0, true);
  throwIfStopped();
}

Progress::~Progress() {
  if (!stopped_) send(1, true);
}

void Progress::report(double done, double total, bool force) {
  send(occtShare_ + (1 - occtShare_) * (total > 0 ? done / total : 1), force);
  throwIfStopped();
}

void Progress::throwIfStopped() const {
  if (stopped_) throw Cancelled(phase_);
}

void Progress::send(double fraction, bool force) {
  // No report after a stop answer: the call is unwinding.
  if (stopped_) return;
  const double now = nowMillis();
  if (!force && now - lastMillis_ < kMinIntervalMillis) return;
  lastMillis_ = now;
  stopped_ = conv_progress(static_cast<int32_t>(phase_), fraction, 1) != 0;
}

void Progress::Show(const Message_ProgressScope&, bool isForce) { send(occtShare_ * GetPosition(), isForce); }

bool Progress::UserBreak() {
  send(occtShare_ * GetPosition(), false);
  return stopped_;
}
