import { z } from "zod";
import { JudgeParseError } from "../errors.js";
import { postJson, type HttpOptions } from "./http.js";
import type { Completer } from "./types.js";

const ResponseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

export function openaiCompleter(model: string, apiKey: string, http: HttpOptions): Completer {
  return {
    id: `openai:${model}`,
    async complete(system, user) {
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
      return parsed.data.choices[0].message.content ?? "";
    },
  };
}
