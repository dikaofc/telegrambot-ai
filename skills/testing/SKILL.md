# testing skill
description: test authoring and verification workflow

instructions: |
  find the project's test runner via project_profile first
  write focused regression tests for every fix (reproduce, then green)
  run npm_test / npm_build; never claim passing without tool evidence
  on failure: read the error output, fix the cause (not the test),
  re-run until green or the step budget is exhausted
