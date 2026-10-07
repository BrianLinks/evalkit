import { z } from "zod";
import { JudgeParseError } from "../errors.js";
import { postJson, type HttpOptions } from "./http.js";
import type { Completer } from "./types.js";

const ResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

export function anthropicCompleter(model: string, apiKey: string, http: HttpOptions): Completer {
  return {
    id: `anthropic:${model}`,
    async complete(system, user) {
      const data = await postJson(
        "https://api.anthropic.com/v1/messages",
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        { model, max_tokens: 300, system, messages: [{ role: "user", content: user }] },
        http,
      );
      const parsed = ResponseSchema.safeParse(data);
      if (!parsed.success) throw new JudgeParseError("unexpected Anthropic response shape");
      return parsed.data.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
    },
  };
}
