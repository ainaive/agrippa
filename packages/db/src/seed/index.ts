import { eq } from "drizzle-orm";
import type { Db } from "../client";
import {
  fabri,
  models,
  orchestrationTemplates,
  orgs,
  scenarios,
  taskTypes,
} from "../schema";

/**
 * Idempotent seed of builtin resources: the default org, the three scenarios,
 * the preset Fabri (硅基人), template heads for the six builtin task types
 * (versions are compiled and published from templates/ in M1.2), the task
 * types, and the Anthropic model registrations.
 */
export async function seed(db: Db): Promise<void> {
  // ── Org ────────────────────────────────────────────────────────────────────
  await db
    .insert(orgs)
    .values({ slug: "default", name: "Silicon Workshop / 硅基工坊" })
    .onConflictDoNothing();
  const [org] = await db.select().from(orgs).where(eq(orgs.slug, "default"));
  if (!org) throw new Error("seed: default org missing after upsert");

  // ── Scenarios ──────────────────────────────────────────────────────────────
  const scenarioRows = [
    {
      slug: "project-management",
      nameI18n: { en: "Project Management", "zh-CN": "项目管理" },
      descriptionI18n: {
        en: "Status reports, planning, and breakdown of project work.",
        "zh-CN": "项目状态报告、计划制定与任务拆解。",
      },
      icon: "clipboard",
      sortOrder: 1,
    },
    {
      slug: "software-development",
      nameI18n: { en: "Software Development", "zh-CN": "软件研发" },
      descriptionI18n: {
        en: "Requirements development, bug localization and fixes.",
        "zh-CN": "需求开发、缺陷定位与修复。",
      },
      icon: "code",
      sortOrder: 2,
    },
    {
      slug: "test-verification",
      nameI18n: { en: "Test & Verification", "zh-CN": "测试验证" },
      descriptionI18n: {
        en: "Test planning and regression verification.",
        "zh-CN": "测试计划与回归验证。",
      },
      icon: "shield-check",
      sortOrder: 3,
    },
  ];
  for (const row of scenarioRows) {
    await db.insert(scenarios).values(row).onConflictDoNothing();
  }
  const scenarioBySlug = new Map(
    (await db.select().from(scenarios)).map((s) => [s.slug, s] as const),
  );

  // ── Fabri (preset agents) ──────────────────────────────────────────────────
  const faberRows = [
    {
      slug: "navigator",
      nameI18n: { en: "Navigator", "zh-CN": "领航者" },
      personaI18n: {
        en: "A pragmatic project manager who keeps plans honest and reports crisp.",
        "zh-CN": "务实的项目管理者，让计划可信、报告清晰。",
      },
      systemPrompt:
        "You are Navigator, a project-management agent. Be factual and structured. " +
        "Ground every status claim in evidence you gathered; never invent progress. " +
        "Prefer tables and short sections; write bilingual-friendly, plain language.",
      avatar: "🧭",
    },
    {
      slug: "forge",
      nameI18n: { en: "Forge", "zh-CN": "铸造者" },
      personaI18n: {
        en: "A careful software engineer who makes minimal, verified changes.",
        "zh-CN": "严谨的软件工程师，追求最小化且经过验证的变更。",
      },
      systemPrompt:
        "You are Forge, a software-development agent. Make the smallest change that " +
        "solves the problem. Verify your work by running it. Follow the conventions " +
        "of the codebase you are working in. Never claim success without evidence.",
      avatar: "🔨",
    },
    {
      slug: "sentinel",
      nameI18n: { en: "Sentinel", "zh-CN": "哨卫" },
      personaI18n: {
        en: "A skeptical test engineer who trusts only what has been executed.",
        "zh-CN": "多疑的测试工程师，只相信真正执行过的结果。",
      },
      systemPrompt:
        "You are Sentinel, a test-and-verification agent. Design tests around risk. " +
        "Run everything you report on; a test that was not executed is not evidence. " +
        "Report failures verbatim and distinguish flaky from deterministic outcomes.",
      avatar: "🛡️",
    },
  ];
  for (const row of faberRows) {
    await db.insert(fabri).values(row).onConflictDoNothing();
  }
  const faberBySlug = new Map((await db.select().from(fabri)).map((f) => [f.slug, f] as const));

  // ── Template heads (versions land in M1.2 from templates/*.yaml) ──────────
  const templateRows = [
    { slug: "pm.status-report", scenario: "project-management", nameI18n: { en: "Status Report", "zh-CN": "状态报告" } },
    { slug: "pm.plan-breakdown", scenario: "project-management", nameI18n: { en: "Plan Breakdown", "zh-CN": "计划拆解" } },
    { slug: "swdev.requirements-dev", scenario: "software-development", nameI18n: { en: "Requirements Development", "zh-CN": "需求开发" } },
    { slug: "swdev.bug-localize-fix", scenario: "software-development", nameI18n: { en: "Bug Localization & Fix", "zh-CN": "缺陷定位与修复" } },
    { slug: "test.test-plan", scenario: "test-verification", nameI18n: { en: "Test Plan", "zh-CN": "测试计划" } },
    { slug: "test.regression-verify", scenario: "test-verification", nameI18n: { en: "Regression Verification", "zh-CN": "回归验证" } },
  ];
  for (const row of templateRows) {
    const scenario = scenarioBySlug.get(row.scenario);
    if (!scenario) throw new Error(`seed: scenario ${row.scenario} missing`);
    await db
      .insert(orchestrationTemplates)
      .values({ slug: row.slug, scenarioId: scenario.id, nameI18n: row.nameI18n })
      .onConflictDoNothing();
  }
  const templateBySlug = new Map(
    (await db.select().from(orchestrationTemplates)).map((t) => [t.slug, t] as const),
  );

  // ── Task types ─────────────────────────────────────────────────────────────
  const taskTypeRows = [
    {
      scenario: "project-management",
      slug: "status-report",
      template: "pm.status-report",
      faber: "navigator",
      nameI18n: { en: "Status Report", "zh-CN": "状态报告" },
      descriptionI18n: {
        en: "Gather repository and tracker activity and synthesize a status report.",
        "zh-CN": "汇总代码仓库与任务活动，生成项目状态报告。",
      },
      sortOrder: 1,
    },
    {
      scenario: "project-management",
      slug: "plan-breakdown",
      template: "pm.plan-breakdown",
      faber: "navigator",
      nameI18n: { en: "Plan Breakdown", "zh-CN": "计划拆解" },
      descriptionI18n: {
        en: "Break a goal or PRD into milestones and estimated tasks.",
        "zh-CN": "将目标或需求文档拆解为里程碑与可估算的任务。",
      },
      sortOrder: 2,
    },
    {
      scenario: "software-development",
      slug: "requirements-dev",
      template: "swdev.requirements-dev",
      faber: "forge",
      nameI18n: { en: "Requirements Development", "zh-CN": "需求开发" },
      descriptionI18n: {
        en: "Turn a requirement into an analyzed design and implementation plan.",
        "zh-CN": "将需求转化为经过分析的设计与实现方案。",
      },
      sortOrder: 1,
    },
    {
      scenario: "software-development",
      slug: "bug-localize-fix",
      template: "swdev.bug-localize-fix",
      faber: "forge",
      nameI18n: { en: "Bug Localization & Fix", "zh-CN": "缺陷定位与修复" },
      descriptionI18n: {
        en: "Reproduce a reported bug, localize the root cause, implement and verify a fix.",
        "zh-CN": "复现缺陷、定位根因、实现修复并验证。",
      },
      sortOrder: 2,
    },
    {
      scenario: "test-verification",
      slug: "test-plan",
      template: "test.test-plan",
      faber: "sentinel",
      nameI18n: { en: "Test Plan", "zh-CN": "测试计划" },
      descriptionI18n: {
        en: "Produce a risk-based test plan and case matrix for a feature or change.",
        "zh-CN": "为功能或变更生成基于风险的测试计划与用例矩阵。",
      },
      sortOrder: 1,
    },
    {
      scenario: "test-verification",
      slug: "regression-verify",
      template: "test.regression-verify",
      faber: "sentinel",
      nameI18n: { en: "Regression Verification", "zh-CN": "回归验证" },
      descriptionI18n: {
        en: "Run test suites against a change and report a verdict with evidence.",
        "zh-CN": "针对变更执行测试套件，输出带证据的验证结论。",
      },
      sortOrder: 2,
    },
  ];
  for (const row of taskTypeRows) {
    const scenario = scenarioBySlug.get(row.scenario);
    const template = templateBySlug.get(row.template);
    const faber = faberBySlug.get(row.faber);
    if (!scenario || !template || !faber) throw new Error(`seed: refs missing for ${row.slug}`);
    await db
      .insert(taskTypes)
      .values({
        scenarioId: scenario.id,
        slug: row.slug,
        nameI18n: row.nameI18n,
        descriptionI18n: row.descriptionI18n,
        templateId: template.id,
        defaultFaberId: faber.id,
        sortOrder: row.sortOrder,
      })
      .onConflictDoNothing();
  }

  // ── Models (Anthropic; prices are list USD per MTok) ──────────────────────
  const modelRows = [
    {
      provider: "anthropic",
      providerModelId: "claude-opus-4-8",
      displayName: "Claude Opus 4.8",
      tier: "strong" as const,
      contextWindow: 1_000_000,
      inputCostPerMtok: "5.00",
      outputCostPerMtok: "25.00",
    },
    {
      provider: "anthropic",
      providerModelId: "claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      tier: "balanced" as const,
      contextWindow: 1_000_000,
      inputCostPerMtok: "3.00",
      outputCostPerMtok: "15.00",
    },
    {
      provider: "anthropic",
      providerModelId: "claude-haiku-4-5",
      displayName: "Claude Haiku 4.5",
      tier: "fast" as const,
      contextWindow: 200_000,
      inputCostPerMtok: "1.00",
      outputCostPerMtok: "5.00",
    },
  ];
  for (const row of modelRows) {
    await db.insert(models).values(row).onConflictDoNothing();
  }
}
