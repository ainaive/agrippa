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

/** Org admin invites a new member by email. role is fixed to org_member for now. */
export const invitationCreateSchema = z.object({
  email: z.email(),
  expiresDays: z.number().int().min(1).max(90).optional(),
});

/** Invitee accepts: token from the invite link, picks name + password. */
export const acceptInviteSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1).max(100),
  password: z.string().min(8).max(128),
});

export const quotaUpdateSchema = z.object({
  tokenLimit: z.number().int().positive().nullable().optional(),
  costLimitUsd: z.number().positive().nullable().optional(),
  hardStop: z.boolean().optional(),
});

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;
export type MemberAddInput = z.infer<typeof memberAddSchema>;
export type InvitationCreateInput = z.infer<typeof invitationCreateSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
export type QuotaUpdateInput = z.infer<typeof quotaUpdateSchema>;

// ── Resource layer ────────────────────────────────────────────────────────────

import { MODEL_TIERS, RESOURCE_TYPES } from "./domain";

/** API-facing localized text: both product locales are mandatory. */
export const localizedTextInputSchema = z
  .object({ en: z.string().min(1), "zh-CN": z.string().min(1) })
  .catchall(z.string());

export const faberCreateSchema = z.object({
  slug: slugSchema,
  nameI18n: localizedTextInputSchema,
  personaI18n: localizedTextInputSchema,
  systemPrompt: z.string().min(1).max(20_000),
  avatar: z.string().max(16).optional(),
});

export const faberUpdateSchema = z.object({
  nameI18n: localizedTextInputSchema.optional(),
  personaI18n: localizedTextInputSchema.optional(),
  systemPrompt: z.string().min(1).max(20_000).optional(),
  avatar: z.string().max(16).nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

export const modelCreateSchema = z.object({
  provider: z.string().min(1),
  providerModelId: z.string().min(1),
  displayName: z.string().min(1),
  tier: z.enum(MODEL_TIERS),
  contextWindow: z.number().int().positive().optional(),
  inputCostPerMtok: z.number().nonnegative().optional(),
  outputCostPerMtok: z.number().nonnegative().optional(),
});

export const modelUpdateSchema = z.object({
  displayName: z.string().min(1).optional(),
  tier: z.enum(MODEL_TIERS).optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  inputCostPerMtok: z.number().nonnegative().nullable().optional(),
  outputCostPerMtok: z.number().nonnegative().nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

export const mcpServerCreateSchema = z.object({
  slug: slugSchema,
  nameI18n: localizedTextInputSchema,
  transport: z.enum(["stdio", "http", "sse"]),
  config: z.record(z.string(), z.unknown()),
  /** Write-only; encrypted into the secrets table, never echoed back. */
  authToken: z.string().min(1).optional(),
});

export const mcpServerUpdateSchema = z.object({
  nameI18n: localizedTextInputSchema.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  authToken: z.string().min(1).nullable().optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

export const skillCreateSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/),
  nameI18n: localizedTextInputSchema,
  descriptionI18n: localizedTextInputSchema,
  source: z.enum(["builtin", "git", "upload"]),
});

export const skillVersionCreateSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "semver x.y.z"),
  contentRef: z.string().min(1),
  manifest: z.record(z.string(), z.unknown()).optional(),
});

export const templateCreateSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/),
  scenarioSlug: slugSchema,
  nameI18n: localizedTextInputSchema,
});

export const templateVersionCreateSchema = z.object({
  sourceYaml: z.string().min(1).max(200_000),
});

export const repoCreateSchema = z.object({
  provider: z.enum(["github", "gitlab", "generic-git"]),
  url: z.url(),
  defaultBranch: z.string().min(1).default("main"),
  /** Write-only; encrypted into the secrets table. */
  token: z.string().min(1).optional(),
});

// ── Execution ─────────────────────────────────────────────────────────────────

export const taskSubmitSchema = z.object({
  taskTypeId: z.uuid(),
  title: z.string().min(1).max(200),
  params: z.record(z.string(), z.unknown()).default({}),
  /** Per-slot overrides of the template's agent bindings (overridable slots only). */
  agents: z
    .record(
      z.string(),
      z.object({
        executorId: z.string().min(1).optional(),
        faberId: z.uuid().optional(),
      }),
    )
    .optional(),
});

/**
 * Kind-discriminated payload for POST /runs/:id/checkpoints/:checkpointId/respond.
 * The server validates the payload kind against the pending checkpoint's kind.
 */
export const checkpointRespondSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("approval"),
      decision: z.enum(["approved", "rejected", "request_changes"]),
      comment: z.string().max(2000).optional(),
    })
    .superRefine((input, ctx) => {
      // a change request IS its comment — the revision step interpolates it,
      // so an empty one would send the agent back with no instructions
      if (input.decision === "request_changes" && !input.comment?.trim()) {
        ctx.addIssue({ code: "custom", message: "request_changes requires a comment" });
      }
    }),
  z.object({
    kind: z.literal("input"),
    answers: z.record(z.string(), z.union([z.string().max(4000), z.boolean()])),
  }),
  z.object({
    kind: z.literal("review-gate"),
    outcome: z.enum(["fix", "accept"]),
    /** Required non-empty when outcome is "fix"; ignored for "accept". */
    selectedFindingIds: z.array(z.string().min(1)).max(100).default([]),
  }),
]);
export type CheckpointRespondInput = z.infer<typeof checkpointRespondSchema>;

export const commentCreateSchema = z.object({
  body: z.string().min(1).max(4000),
});
export type CommentCreateInput = z.infer<typeof commentCreateSchema>;

export const grantsPutSchema = z.array(
  z.object({
    resourceType: z.enum(RESOURCE_TYPES),
    resourceId: z.uuid(),
    configOverride: z.record(z.string(), z.unknown()).optional(),
  }),
);
