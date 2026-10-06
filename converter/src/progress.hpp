// Progress reporting to the host through the env.conv_progress import, throttled to a few milliseconds, and the
// host's answer to each report: 0 to go on, 1 to stop the call.
#pragma once

#include <Message_ProgressIndicator.hxx>
#include <Message_ProgressRange.hxx>

#include <stdexcept>

enum class Phase : int { read = 1, transfer = 2, mesh = 3, geometry = 4 };

// The host answered stop to a progress report: error code -5.
struct Cancelled : std::runtime_error {
  explicit Cancelled(Phase phase);
};

// Connects an OpenCascade algorithm's progress scope to the host. Start() gives the range to pass into the
// algorithm; report() serves the converter's own loops. Construction and destruction report the phase's start and end.
// The host sees one fraction per phase, rising from 0 to 1: the OpenCascade scope covers the first `occtShare`
// of it, and report() maps done/total onto the rest.
//
// A stop answer holds for the rest of the call. OpenCascade's scopes read it through UserBreak() and leave their
// loops, so the algorithm returns early with a failure status and its caller asks throwIfStopped(). The converter's
// own loops get a Cancelled out of report() itself.
class Progress : public Message_ProgressIndicator {
  DEFINE_STANDARD_RTTI_INLINE(Progress, Message_ProgressIndicator)
public:
  // Reports the start and throws Cancelled if the host answers stop, so the call ends before its work.
  explicit Progress(Phase phase, double occtShare = 0);
  // Reports the end, unless the host stopped the call: then the report it answered was the last.
  ~Progress() override;

  // Reports done/total unless a report went out within the last few milliseconds; force skips the throttle.
  // Throws Cancelled once the host has answered stop, to this report or an earlier one.
  void report(double done, double total, bool force = false);
  bool stopped() const { return stopped_; }
  void throwIfStopped() const;

  void Show(const Message_ProgressScope& scope, bool isForce) override;
  // Polled by OpenCascade's loops, between the steps of a fix among others, more often than its scopes advance.
  // A poll also asks the host when the throttle allows, so a stop lands at the next poll and not only at the
  // next advance.
  bool UserBreak() override;

private:
  // The report without the throw: Show() runs inside OpenCascade, where an exception would unwind through
  // progress scopes closing in destructors.
  void send(double fraction, bool force);

  Phase phase_;
  double occtShare_;
  double lastMillis_ = -1e12;
  bool stopped_ = false;
};
