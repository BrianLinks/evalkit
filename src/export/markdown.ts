import type { ReportDocument } from "./model.js";

/** Escape characters that would change meaning in Markdown, or pass raw HTML through. */
export function escapeMarkdown(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/[\\`*_|<>]/g, (c) => `\\${c}`);
}

export function renderMarkdown(doc: ReportDocument): string {
  const out: string[] = [`# ${escapeMarkdown(doc.title)}`, ""];
  if (doc.subtitle) out.push(`*${escapeMarkdown(doc.subtitle)}*`, "");
  if (doc.facts.length > 0) {
    for (const [label, value] of doc.facts) out.push(`- **${escapeMarkdown(label)}:** ${escapeMarkdown(value)}`);
    out.push("");
  }

  for (const block of doc.blocks) {
    switch (block.type) {
      case "heading":
        out.push(`${"#".repeat(block.level)} ${escapeMarkdown(block.text)}`, "");
        break;
      case "paragraph":
        out.push(escapeMarkdown(block.text), "");
        break;
      case "warning":
        out.push(`> **Warning:** ${escapeMarkdown(block.text)}`, "");
        break;
      case "note":
        out.push(`*${escapeMarkdown(block.text)}*`, "");
        break;
      case "table": {
        if (block.rows.length === 0) break;
        const cells = (row: string[]): string => `| ${row.map(escapeMarkdown).join(" | ")} |`;
        out.push(cells(block.header));
        out.push(`| ${block.header.map((_, i) => (i === 0 ? ":---" : "---:")).join(" | ")} |`);
        for (const row of block.rows) out.push(cells(row));
        out.push("");
        break;
      }
    }
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
