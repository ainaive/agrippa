import { z } from "zod";
import { PROJECT_ROLES } from "./domain";
import { LOCALES } from "./i18n";

export const slugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,48}$/, "lowercase letters, digits, and dashes; 2-49 chars");

export const meUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  locale: z.enum(LOCALES).optional(),
});

export const projectCreateSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
});

export const projectUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).nullable().optional(),
});

export const memberAddSchema = z.object({
  email: z.email(),
  role: z.enum(PROJECT_ROLES),
});

export const memberUpdateSchema = z.object({
  role: z.enum(PROJECT_ROLES),
});

export const quotaUpdateSchema = z.object({
  tokenLimit: z.number().int().positive().nullable().optional(),
  costLimitUsd: z.number().positive().nullable().optional(),
  hardStop: z.boolean().optional(),
});

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;
export type MemberAddInput = z.infer<typeof memberAddSchema>;
export type QuotaUpdateInput = z.infer<typeof quotaUpdateSchema>;
