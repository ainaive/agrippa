# Concepts

**Project** — the collaboration unit and the boundary for everything: membership, resource grants, budgets/quotas, repositories, and billing attribution. Users can belong to many projects with different roles: **admin** (manage members, grants, repos, quota), **member** (submit tasks, decide approvals, cancel runs), **viewer** (read-only).

**Scenario & task type** — the catalog is organized by work scenario (project management, software development, test & verification). A *task type* is one concrete thing you can ask for — "Bug Localization & Fix", "Test Plan" — and binds a scenario to an orchestration template and a default Faber.

**Task & run** — a *task* is your submission: a task type, a title, and parameters. Executing it produces a *run*; retrying a finished task produces run #2, #3… Each run is pinned to the exact template version that was current at submission, so later template changes never affect it.

**Step** — the atomic unit inside a run: one agent invocation (or one system action such as checking out the repository). Steps are what you see on the run timeline, and they're the platform's unit of retry and crash recovery.

**Faber** (plural **Fabri**, 硅基人) — a preset platform agent: a persona and system prompt under which runs execute. M1 ships three: Navigator 领航者 (project management), Forge 铸造者 (software development), Sentinel 哨卫 (testing).

**Orchestration template** — the versioned, declarative recipe a run follows: input parameters (which auto-generate the submission form), phases and steps, which skills/MCP servers/sub-agents each step uses, model-selection rules, human-approval checkpoints, budgets, and the artifact contract. Published versions are immutable; editing creates the next version.

**Model roles & tiers** — templates never name concrete models. They declare roles (e.g. `planning`, `coding`, `fast`) mapped to tiers (**strong / balanced / fast**); at submission the platform resolves each role to the cheapest granted model of that tier. Swapping a project's model lineup requires no template changes.

**Artifact & output contract** — the declared deliverables of a run (reports, patches, links). A template marks which artifacts are *required*; a run only counts as **succeeded** if every required artifact was produced. Artifacts are downloadable from the run's Artifacts tab.

**Approval** — a human checkpoint defined in the template before a phase (e.g. "approve the fix plan before code changes"). The run pauses as *waiting approval* — holding no compute — until a project member approves or rejects, with an optional comment. Approvals also have a timeout with a template-defined outcome.

**Budget vs quota** — a *budget* belongs to the template/run: max cost and duration for one run (optionally per phase). A *quota* belongs to the project: monthly cost/token ceilings across all runs. With **hard stop** enabled, an exhausted quota rejects new submissions and aborts in-flight runs at the next step boundary; without it, it's advisory.

**Resource grant** — the switch that makes a registry resource (model, skill, MCP server, Faber) usable inside a project. Registries are org-wide; grants are per-project — that's how an admin controls which team can use which model or integration.

**Run statuses** — `queued → running → succeeded | failed | cancelled | timed_out`, with `running ⇄ waiting_approval` for checkpoints. Failed runs carry a machine-readable error code plus a human message.
