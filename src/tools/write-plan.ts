import { z } from "zod";
import type { PlanState } from "../runtime/contracts.js";
import type { LlmTool } from "../llm/openai-client.js";

const planInputSchema = z.object({
  items: z
    .array(
      z.object({
        content: z.string().min(1),
        status: z.enum(["pending", "in_progress", "completed"])
      })
    )
    .min(1)
    .max(7),
  summary: z.string().min(1)
});

type PlanInput = z.infer<typeof planInputSchema>;

export function createWritePlanTool(args: {
  getPlan: () => PlanState | null;
  setPlan: (plan: PlanState) => void;
}): LlmTool {
  return {
    description:
      "Create or replace the current execution plan for this task. Use it before multi-step work and update it when item status changes.",
    inputSchema: planInputSchema,
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: {
          type: "string",
          description: "Short plan summary."
        },
        items: {
          type: "array",
          minItems: 1,
          maxItems: 7,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              content: {
                type: "string",
                description: "Concrete plan item."
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"]
              }
            },
            required: ["content", "status"]
          }
        }
      },
      required: ["summary", "items"]
    },
    name: "write_plan",
    async run(input) {
      const parsed = planInputSchema.parse(input);
      const nextPlan = normalizePlan(parsed, args.getPlan());
      args.setPlan(nextPlan);
      return JSON.stringify({
        itemCount: nextPlan.items.length,
        ok: true,
        plan: nextPlan,
        summary: nextPlan.summary
      });
    }
  };
}

function normalizePlan(input: PlanInput, currentPlan: PlanState | null): PlanState {
  return {
    summary: input.summary,
    items: input.items.map((item, index) => ({
      id: currentPlan?.items[index]?.id ?? `plan-${index + 1}`,
      content: item.content,
      status: item.status
    }))
  };
}
