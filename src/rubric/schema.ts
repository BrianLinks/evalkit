import { z } from "zod";

const AnchorSchema = z.object({ score: z.number().int(), text: z.string().min(1) });

export const CriterionSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "criterion id must start with a letter and use letters, digits, _ or -"),
  weight: z.number().positive(),
  ask: z.string().min(1),
  anchors: z.array(AnchorSchema),
});

export const ScaleSchema = z
  .object({ min: z.number().int(), max: z.number().int() })
  .refine((s) => s.max > s.min, { message: "scale max must be greater than min" });

export const RubricSchema = z
  .object({
    name: z.string().min(1),
    scale: ScaleSchema,
    criteria: z.array(CriterionSchema).min(1, "rubric needs at least one criterion"),
  })
  .superRefine((rubric, ctx) => {
    const ids = new Set<string>();
    rubric.criteria.forEach((criterion, ci) => {
      if (ids.has(criterion.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate criterion id "${criterion.id}"`, path: ["criteria", ci, "id"] });
      }
      ids.add(criterion.id);
      const anchored = new Set<number>();
      criterion.anchors.forEach((anchor, ai) => {
        const path = ["criteria", ci, "anchors", ai];
        if (anchor.score < rubric.scale.min || anchor.score > rubric.scale.max) {
          ctx.addIssue({ code: "custom", message: `anchor ${anchor.score} is outside the scale ${rubric.scale.min}..${rubric.scale.max}`, path });
        }
        if (anchored.has(anchor.score)) {
          ctx.addIssue({ code: "custom", message: `duplicate anchor ${anchor.score}`, path });
        }
        anchored.add(anchor.score);
      });
    });
  });

export type Rubric = z.infer<typeof RubricSchema>;
export type Criterion = z.infer<typeof CriterionSchema>;
