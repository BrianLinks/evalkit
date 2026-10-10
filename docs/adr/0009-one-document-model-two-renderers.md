# 0009: One document model, two renderers

Status: accepted

## Context
Results need to be shareable with people who will not use a terminal. Markdown suits READMEs, pull requests and notes; HTML suits email attachments and browsers. Building each format straight from the report data would let them drift apart, and each would need its own escaping logic woven through the content.

## Decision
Build each report once into a small document model (headings, paragraphs, tables, warnings, notes), then render that model to Markdown and to HTML. Escaping lives in the renderers only, since it depends on the target format. The HTML renderer produces one file with inline CSS, no scripts, no external resources, a restrictive Content-Security-Policy, and light and dark colour schemes. Export never overwrites an existing file unless asked, and optional sections (length bias) are included only when the user supplies the original dataset, which is hash-checked as for the bias commands.

## Consequences
- The two formats carry the same content by construction, and a test checks that every table cell appears in both.
- Text from rubrics, datasets and judge names is untrusted. Escaping it in the renderers means a hostile rubric name cannot inject markup or script into an exported report.
- The HTML is plain and has no charts. Adding charts would mean inline SVG, which fits the same constraints but is not done yet.
- The visual layout of the HTML has been checked structurally (balanced tags, no external references) but not by eye in a browser during development.
- Another format such as PDF would be one more renderer over the same model.
