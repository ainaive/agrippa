import type {
  CheckpointKind,
  CheckpointStoredResponse,
  LocalizedText,
  ProjectRole,
  Question,
  ReviewFinding,
  RunStatus,
  StepStatus,
} from "@agrippa/core";

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

export type AgentSlotMeta = {
  label: LocalizedText;
  overridable: boolean;
  defaultFaberId: string | null;
  defaultExecutorId: string;
  executorLabel: string;
  /** Whether a worker in this deployment has registered the default executor. */
  available: boolean;
};

export type FaberOption = {
  id: string;
  slug: string;
  nameI18n: LocalizedText;
  avatar: string | null;
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
  /** Agent slots of the pinned template (null before any published version). */
  agents: Record<string, AgentSlotMeta> | null;
  /** Live executor ids from worker heartbeats; null = none advertised yet. */
  availableExecutorIds: string[] | null;
  /** Active fabri selectable for overridable slots. */
  fabriOptions: FaberOption[];
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
  agents: Record<string, { label: LocalizedText; overridable: boolean }>;
  phases: Array<{
    id: string;
    name: LocalizedText;
    loop: { id: string; name: LocalizedText; maxIterations: number } | null;
    stepIds: string[];
    checkpoints: Array<{
      id: string;
      kind: CheckpointKind;
      title: LocalizedText;
      present: string[];
    }>;
    approval: { checkpoint: string; title: LocalizedText; present: string[] } | null;
  }>;
  budgets: RunBudgets;
  modelRoles: Record<string, { tier: string; fallback: string[] }>;
};

export type RunAgentBinding = {
  faberId: string;
  faberSlug: string | null;
  faberName: LocalizedText | null;
  faberAvatar: string | null;
  executorId: string;
  executorLabel: string;
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
  modelResolution: Record<string, ModelResolutionEntry | Record<string, ModelResolutionEntry>>;
  budget: RunBudgets;
  usageTotals: { costUsd?: number; tokens?: number };
  workspaceRef: string | null;
  workBranch: string | null;
  error: { code: string; message: string } | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  template: RunTemplate | null;
  /** slot → resolved faber/executor metadata. */
  agents: Record<string, RunAgentBinding>;
  checkpoints: Checkpoint[];
};

export type RunStep = {
  id: string;
  phaseId: string;
  stepId: string;
  iteration: number;
  attempt: number;
  seq: number;
  status: StepStatus;
  agentRef: string | null;
  output: string | null;
  usage: { costUsd?: number; tokens?: number };
  startedAt: string | null;
  finishedAt: string | null;
};

export type CheckpointPayload = {
  title?: LocalizedText;
  present?: string[];
  loopId?: string | null;
  questions?: Question[];
  summary?: string;
  findings?: ReviewFinding[];
};

export type Checkpoint = {
  id: string;
  checkpointId: string;
  kind: CheckpointKind;
  iteration: number;
  status: "pending" | "approved" | "rejected" | "expired";
  payload: CheckpointPayload;
  response: CheckpointStoredResponse | null;
  requestedAt: string;
  decidedAt: string | null;
  comment: string | null;
  deciderName?: string | null;
};

export type RunComment = {
  id: string;
  body: string;
  createdAt: string;
  userId: string;
  userName: string;
};

export type Artifact = {
  id: string;
  artifactKey: string;
  iteration: number;
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

export type ProviderCredentialRow = {
  id: string;
  provider: string;
  baseUrl: string | null;
  hasCredential: boolean;
  createdAt: string;
  rotatedAt: string | null;
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
