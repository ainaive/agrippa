import type { LocalizedText, ProjectRole, RunStatus, StepStatus } from "@agrippa/core";

export type Me = {
  id: string;
  email: string;
  name: string;
  locale: string;
  orgRole: "org_admin" | "org_member";
  projects: Array<{
    projectId: string;
    slug: string;
    name: string;
    status: string;
    role: ProjectRole;
  }>;
};

export type Scenario = {
  id: string;
  slug: string;
  nameI18n: LocalizedText;
  descriptionI18n: LocalizedText;
  icon: string | null;
};

export type TaskTypeSummary = {
  id: string;
  slug: string;
  nameI18n: LocalizedText;
  descriptionI18n: LocalizedText;
  templateSlug: string;
  faberSlug: string;
  faberNameI18n: LocalizedText;
  faberAvatar: string | null;
};

export type TemplateInputSpec = {
  key: string;
  type: "string" | "text" | "number" | "boolean" | "select" | "repoRef" | "docRef";
  required: boolean;
  default?: string | number | boolean;
  label: LocalizedText;
  help?: LocalizedText;
  ui?: Record<string, string | number | boolean>;
  options?: Array<{ value: string; label: LocalizedText }>;
};

export type TaskTypeDetail = {
  id: string;
  slug: string;
  nameI18n: LocalizedText;
  descriptionI18n: LocalizedText;
  template: { id: string; slug: string } | null;
  templateVersion: { id: string; version: number } | null;
  faber: { id: string; slug: string; nameI18n: LocalizedText; avatar: string | null } | null;
  inputs: TemplateInputSpec[];
  budgets: { maxCostUsd?: number; maxDurationMinutes?: number } | null;
};

export type TaskRow = {
  id: string;
  title: string;
  taskTypeId: string;
  createdAt: string;
  latestRunId: string | null;
  runStatus: RunStatus | null;
  runNumber: number | null;
};

export type ModelResolutionEntry = {
  role: string;
  tier: string;
  modelId: string;
  provider: string;
  providerModelId: string;
};

export type RunBudgets = {
  maxCostUsd?: number;
  maxDurationMinutes?: number;
  perPhase?: Record<string, { maxCostUsd: number }>;
};

export type RunTemplate = {
  slug: string;
  version: number;
  phases: Array<{
    id: string;
    name: LocalizedText;
    stepIds: string[];
    approval: { checkpoint: string; title: LocalizedText; present: string[] } | null;
  }>;
  budgets: RunBudgets;
  modelRoles: Record<string, { tier: string; fallback: string[] }>;
};

export type Run = {
  id: string;
  taskId: string;
  projectId: string;
  number: number;
  status: RunStatus;
  templateVersionId: string;
  faberId: string;
  executorId: string;
  paramsSnapshot: Record<string, unknown>;
  modelResolution: Record<string, ModelResolutionEntry>;
  budget: RunBudgets;
  usageTotals: { costUsd?: number; tokens?: number };
  workspaceRef: string | null;
  error: { code: string; message: string } | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  template: RunTemplate | null;
};

export type RunStep = {
  id: string;
  phaseId: string;
  stepId: string;
  attempt: number;
  seq: number;
  status: StepStatus;
  agentRef: string | null;
  output: string | null;
  usage: { costUsd?: number; tokens?: number };
  startedAt: string | null;
  finishedAt: string | null;
};

export type Approval = {
  id: string;
  checkpointId: string;
  status: "pending" | "approved" | "rejected" | "expired";
  payload: { title?: LocalizedText; present?: string[] };
  requestedAt: string;
  comment: string | null;
};

export type Artifact = {
  id: string;
  artifactKey: string;
  kind: string;
  name: string;
  size: number | null;
  createdAt: string;
};

export type Member = {
  userId: string;
  email: string;
  name: string;
  role: ProjectRole;
};

export type Grant = {
  id: string;
  resourceType: string;
  resourceId: string;
};

export type Faber = {
  id: string;
  slug: string;
  nameI18n: LocalizedText;
  personaI18n: LocalizedText;
  avatar: string | null;
  status: string;
};

export type ModelRow = {
  id: string;
  provider: string;
  providerModelId: string;
  displayName: string;
  tier: string;
  inputCostPerMtok: string | null;
  outputCostPerMtok: string | null;
  status: string;
};

export type SkillRow = {
  id: string;
  slug: string;
  nameI18n: LocalizedText;
  source: string;
  versions: Array<{ id: string; version: string; status: string }>;
};

export type McpServerRow = {
  id: string;
  slug: string;
  nameI18n: LocalizedText;
  transport: string;
  hasAuth: boolean;
  status: string;
};

export type TemplateRow = {
  id: string;
  slug: string;
  nameI18n: LocalizedText;
  scenarioSlug: string;
  latestPublishedVersionId: string | null;
};

export type Quota = {
  tokenLimit: number | null;
  costLimitUsd: string | null;
  hardStop: boolean;
} | null;
