/**
 * A small document model. Reports are built into this once, then rendered to Markdown or HTML,
 * so both formats always contain the same content.
 */
export type Block =
  | { type: "heading"; level: 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "warning"; text: string }
  | { type: "note"; text: string }
  | { type: "table"; header: string[]; rows: string[][] };

export interface ReportDocument {
  title: string;
  subtitle?: string;
  /** Key facts shown under the title, in order. */
  facts: [label: string, value: string][];
  blocks: Block[];
}
