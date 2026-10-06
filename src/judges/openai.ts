import { z } from "zod";
import { JudgeParseError } from "../errors.js";
import { postJson, type HttpOptions } from "./http.js";
import { buildPrompt, parseVerdict } from "./prompt.js";
import type { Judge } from "./types.js";

const ResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

export function openaiJudge(model: string, apiKey: string, http: HttpOptions): Judge {
  return {
    id: `openai:${model}`,
    async judge(request) {
      const { system, user } = buildPrompt(request);
      const data = await postJson(
        "https://api.openai.com/v1/chat/completions",
        { authorization: `Bearer ${apiKey}` },
        {
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
        },
        http,
      );
      const parsed = ResponseSchema.safeParse(data);
      if (!parsed.success) throw new JudgeParseError("unexpected OpenAI response shape");
      return parseVerdict(parsed.data.choices[0].message.content ?? "", request.rubric);
    },
  };
}
