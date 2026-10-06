# 0001: Line-based rubric DSL

Status: accepted

## Context
Rubrics are written and reviewed by people, often next to prose. They need criteria, weights, a score scale and optional score anchors. YAML and JSON can express this, but they hide mistakes (bad indentation, stray commas) and give poor error locations.

## Decision
Use a small line-based format with four directives (`rubric`, `scale`, `criterion`, and indented `ask:` and `anchor`). Parse it by hand, then validate the result with a zod schema.

## Consequences
- Error messages name the exact line.
- The grammar is tiny and easy to read in a diff.
- It is a custom format, so there is no editor tooling. Cross-field rules (unique ids, anchors inside the scale) live in the schema, so a rubric built in code gets the same checks.
