# refactor skill
description: safe refactoring workflow

instructions: |
  map usages first (graphify_query or search_code) so renames are complete
  checkpoint_create before structural changes
  small steps: rename → move → simplify, verifying tests after each step
  no behavior change unless the user asked for it; keep diffs reviewable
  run format_code at the end, then full verification
