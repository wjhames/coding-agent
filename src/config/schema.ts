import { z } from "zod";

export const approvalPolicySchema = z.enum(["auto", "prompt", "never"]);

export const profileSchema = z
  .object({
    apiKeyEnv: z.string().min(1).optional(),
    approvalPolicy: approvalPolicySchema.optional(),
    baseUrl: z.string().url().optional(),
    maxSteps: z.number().int().positive().optional(),
    model: z.string().min(1).optional(),
    networkEgress: z.boolean().optional(),
    timeout: z.string().min(1).optional()
  })
  .strict();

export const configSchema = z
  .object({
    defaultProfile: z.string().min(1).optional(),
    profiles: z.record(z.string(), profileSchema).default({})
  })
  .strict();

export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;
export type CodingAgentProfile = z.infer<typeof profileSchema>;
export type CodingAgentConfig = z.infer<typeof configSchema>;
