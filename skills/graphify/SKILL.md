# graphify skill
description: knowledge-graph-first codebase navigation (Graphify Labs)

instructions: |
  graphify maps the workspace into a queryable knowledge graph
  (code AST locally, no LLM needed for code-only indexing).

  workflow:
  1. check graphify_status for the active workspace
  2. if no graph exists and the task needs codebase understanding,
     run graphify_build (extract . --code-only, fully offline)
  3. prefer graphify_query / graphify_path / graphify_explain
     over raw grep for architecture questions:
     - "what connects auth to the database?" -> graphify_query
     - how A relates to B -> graphify_path A B
     - what is X and who uses it -> graphify_explain X
  4. use targeted read_file only for the exact files the graph points to
  5. if the graphify CLI is not installed, say so and continue with
     search_code/grep instead of claiming graph results
