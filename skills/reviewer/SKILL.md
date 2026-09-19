# reviewer skill
description: code review workflow

instructions: |
  review diffs, not vibes: use git_diff and read the changed lines
  check for: regressions, broken edge cases, missing error handling,
  leaked secrets, over-broad changes, untested paths
  verify with tests before approving; list issues by severity
  suggest minimal fixes, don't rewrite unrelated code
