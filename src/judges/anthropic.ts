import { z } from "zod";
import { JudgeParseError } from "../errors.js";
import { postJson, type HttpOptions } from "./http.js";
import { buildPrompt, parseVerdict } from "./prompt.js";
import type { Judge } from "./types.js";

const ResponseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

export function anthropicJudge(model: string, apiKey: string, http: HttpOptions): Judge {
  return {
    id: `anthropic:${model}`,
    async judge(request) {
      const { system, user } = buildPrompt(request);
      const data = await postJson(
        "https://api.anthropic.com/v1/messages",
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        { model, max_tokens: 300, system, messages: [{ role: "user", content: user }] },
        http,
      );
      const parsed = ResponseSchema.safeParse(data);
      if (!parsed.success) throw new JudgeParseError("unexpected Anthropic response shape");
      const text = parsed.data.content.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
      return parseVerdict(text, request.rubric);
    },
  };
}
