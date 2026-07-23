export const ORG_ROLES = ["org_admin", "org_member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const PROJECT_ROLES = ["admin", "member", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** admin ⊃ member ⊃ viewer */
export function projectRoleAtLeast(role: ProjectRole, min: ProjectRole): boolean {
  const rank: Record<ProjectRole, number> = { admin: 3, member: 2, viewer: 1 };
  return rank[role] >= rank[min];
}

export const RESOURCE_TYPES = ["skill", "mcp_server", "model", "template", "faber"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const MODEL_TIERS = ["strong", "balanced", "fast"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const ARTIFACT_KINDS = ["file", "patch", "markdown", "json", "link"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * Human-in-the-loop checkpoint kinds (agrippa/v2 templates, ADR-0010).
 * `approval` gates on a decision, `input` collects answers to agent-authored
 * questions, `review-gate` decides what happens to review findings.
 */
export const CHECKPOINT_KINDS = ["approval", "input", "review-gate"] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

export const REVIEW_SEVERITIES = ["blocker", "major", "minor", "info"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];
