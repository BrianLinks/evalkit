import type { ReportDocument } from "./model.js";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

const STYLE = `
:root { --bg: #ffffff; --fg: #1b1f24; --muted: #5b6570; --line: #d6dbe1; --head: #f1f4f7; --warn-bg: #fff4e5; --warn-line: #c76a00; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #14171a; --fg: #e6e9ec; --muted: #9aa5b1; --line: #343b42; --head: #1d2227; --warn-bg: #33250f; --warn-line: #e08a1e; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 56rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
h1 { font-size: 1.75rem; margin: 0 0 .25rem; }
h2 { font-size: 1.3rem; margin: 2.25rem 0 .5rem; padding-top: .5rem; border-top: 1px solid var(--line); }
h3 { font-size: 1.05rem; margin: 1.5rem 0 .5rem; }
.subtitle, .note { color: var(--muted); }
.note { font-size: .9rem; }
dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 1rem 0; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; overflow-wrap: anywhere; }
.table-wrap { overflow-x: auto; margin: .75rem 0 1.25rem; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { border: 1px solid var(--line); padding: .35rem .6rem; text-align: right; white-space: nowrap; }
th:first-child, td:first-child { text-align: left; white-space: normal; }
th { background: var(--head); font-weight: 600; }
.warning { background: var(--warn-bg); border-left: 4px solid var(--warn-line); padding: .6rem .9rem; margin: 1rem 0; }
@media print { body { font-size: 12px; } main { max-width: none; padding: 0; } .table-wrap { overflow: visible; } }
`;

/** A single self-contained file: no scripts, no external resources, and a CSP that forbids both. */
export function renderHtml(doc: ReportDocument): string {
  const e = escapeHtml;
  const body: string[] = [`<h1>${e(doc.title)}</h1>`];
  if (doc.subtitle) body.push(`<p class="subtitle">${e(doc.subtitle)}</p>`);
  if (doc.facts.length > 0) {
    body.push('<dl class="facts">', ...doc.facts.map(([label, value]) => `<dt>${e(label)}</dt><dd>${e(value)}</dd>`), "</dl>");
  }

  for (const block of doc.blocks) {
    switch (block.type) {
      case "heading":
        body.push(`<h${block.level}>${e(block.text)}</h${block.level}>`);
        break;
      case "paragraph":
        body.push(`<p>${e(block.text)}</p>`);
        break;
      case "warning":
        body.push(`<div class="warning" role="alert"><strong>Warning:</strong> ${e(block.text)}</div>`);
        break;
      case "note":
        body.push(`<p class="note">${e(block.text)}</p>`);
        break;
      case "table":
        if (block.rows.length === 0) break;
        body.push(
          '<div class="table-wrap"><table>',
          `<thead><tr>${block.header.map((h) => `<th scope="col">${e(h)}</th>`).join("")}</tr></thead>`,
          `<tbody>${block.rows.map((row) => `<tr>${row.map((c) => `<td>${e(c)}</td>`).join("")}</tr>`).join("")}</tbody>`,
          "</table></div>",
        );
        break;
    }
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${e(doc.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body.join("\n")}
</main>
</body>
</html>
`;
}
