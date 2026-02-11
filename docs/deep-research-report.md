# Ralph Loop Architecture for Spec-Driven, Multi-Agent GitHub Delivery with Codex and Claude

## Executive summary

A “Ralph loop” applied to software delivery is a deterministic iteration pattern: each loop iteration starts the model with a fresh context window and relies on external state (repo files, tests, git history, spec artifacts) to preserve progress, preventing “context rot” and drift over long sessions. citeturn14view1turn14view2 In practice, modern Ralph-oriented orchestrators formalize this as a thin coordination layer that keeps agents working until explicit completion criteria are met. citeturn14view0turn14view3

For your target system, the cleanest end-to-end design is an event-driven orchestration service that listens to GitHub task signals (issues, Projects items, labels, comments, workflow_dispatch), generates a formal spec with OpenAI Codex (or another code-gen LLM), decomposes the spec into parallelizable sub-tasks, dispatches those to a pool of Claude “agents” (workers calling the Claude Messages API), and then runs an automated review-and-merge gate using CI plus LLM-based code review (often Codex) before merging with branch protection / rulesets / merge queue.

Key architectural choices that dominate reliability and security:

OpenAI integration should use the Responses API (the same interface Codex CLI uses) for agentic planning/review loops and structured outputs, with Codex SDK or Codex App Server used depending on whether you need CI automation (SDK) or a rich interactive harness (App Server). citeturn8view2turn11view1turn11view0 GitHub integration should be built as a GitHub App (preferred over OAuth or PATs) because GitHub Apps use fine-grained permissions and short-lived tokens, reducing blast radius. citeturn0search3turn7search10turn8view6 Claude integration should use the Messages API at `POST /v1/messages` with required `x-api-key` and `anthropic-version` headers. citeturn9view0turn8view4 Finally, merges should be guarded by required status checks and (optionally) merge queue; if you use merge queue with GitHub Actions you must trigger workflows on `merge_group` in addition to `pull_request`/`push`. citeturn8view7turn1search11turn2search0

## Reference architecture and data flow

The system has three planes:

Control plane: webhook ingestion, auth, orchestration state machine, routing decisions (task splitting, retries, stopping).  
Work plane: Claude agent workers plus sandboxed build/test runners that modify code and produce PR updates.  
Governance plane: automated and human review, policy enforcement, audit logs, and merge controls.

The following diagram shows a cloud-agnostic reference flow. The orchestration and runners can run on VMs, containers, Kubernetes, or a serverless platform; the key is that the orchestration state is durable and idempotent.

```mermaid
flowchart LR
  subgraph GitHub[GitHub]
    I[Issues / Project items] -->|events| WH[Webhooks]
    PR[Pull Requests] --> CI[Checks / CI]
    RULES[Branch protection / Rulesets / Merge queue]
  end

  subgraph Orchestrator[Orchestration layer]
    H[Webhook handler + signature verification]
    SM[Durable workflow state machine]
    Q[(Work queue)]
    ST[(State store: DB + object/artifact store)]
  end

  subgraph LLMs[LLM services]
    CX[OpenAI Codex / code-gen LLM\n(spec generation + review)]
    CL[Claude Messages API\n(execution agents)]
  end

  subgraph Runners[Execution + validation]
    W1[Claude agent worker(s)]
    SB[Sandboxed repo workspace]
    T[Unit/Integration tests + linters + SAST]
  end

  WH --> H --> SM
  SM -->|fetch task context| GitHub
  SM -->|generate formal spec| CX
  CX -->|Spec vN| ST
  SM -->|split into subtasks| Q
  Q --> W1 -->|apply changes| SB
  SB -->|push branch + open/update PR| GitHub
  GitHub --> CI -->|results| SM
  SM -->|LLM code review on diff + CI| CX
  SM -->|approve/annotate| PR
  SM -->|if green + policy| RULES -->|merge/queue| PR
  SM -->|loop if failed| Q
```

This architecture aligns with how GitHub webhooks and branch protection are intended to be used (real-time notifications → automated checks → enforcement at merge time). citeturn1search18turn1search7turn2search0 It also aligns with OpenAI’s Codex “harness” concept: Codex CLI orchestrates user/model/tool interaction by driving a loop through the Responses API. citeturn8view2

Required components and roles (minimal viable set):

GitHub: source of tasks (Issues/Projects) and the system of record for code changes (branches/PRs), plus checks and merge policy. citeturn5search3turn5search2turn2search5  
Webhook ingestion: verifies GitHub payload signatures and turns events into internal “TaskRequested” messages. GitHub recommends `X-Hub-Signature-256` (HMAC-SHA256) for validation. citeturn8view5turn10view0  
Orchestration state machine: enforces Ralph-loop iteration semantics, tracks attempts, stores artifacts, and schedules work. The “fresh context each iteration; external state carries progress” principle is the defining Ralph loop feature. citeturn14view1turn14view0  
Spec generator (Codex): generates a formal spec and later performs LLM-based review. OpenAI provides Codex SDK for CI/CD automation and Codex App Server for deep client integration; Codex CLI itself drives model inference via the Responses API. citeturn11view1turn11view0turn8view2  
Claude “agents”: worker processes calling Claude’s Messages API to implement sub-tasks, optionally with tools (repo read/write, test execution) controlled by your orchestrator. citeturn9view0turn4search15  
CI/CD: executes tests/linters/security scanning and reports results as GitHub checks/statuses; required checks can be enforced via branch protection/rulesets. citeturn1search11turn1search7turn2search13  
Storage: state store (DB) + artifact store (logs, specs, traces, build outputs). In Ralph loops, external persistence is what makes “fresh context” iterations coherent. citeturn14view1  
Auth + secrets: GitHub App tokens, OpenAI API keys, Anthropic API keys, plus a secrets manager. GitHub Apps are generally preferred because they use fine-grained permissions and short-lived tokens. citeturn0search3turn8view6

## APIs, authentication, and integration choices

### Core APIs and their auth requirements

GitHub webhooks: GitHub delivers events via HTTP POST and (when configured with a secret) includes `X-Hub-Signature-256` which is an HMAC digest of the request body using SHA-256; GitHub recommends using this header over the legacy SHA-1 variant. citeturn8view5turn10view0

GitHub App authentication: a GitHub App can authenticate as itself (JWT signed with RS256) to obtain an installation access token; installation tokens expire after one hour and are then used with REST or GraphQL. citeturn7search14turn8view6turn7search10

OpenAI API authentication: OpenAI’s API uses API keys and advises providing them via HTTP Bearer authentication; keys should be treated as secrets and not embedded client-side. citeturn8view0turn3search3

OpenAI Responses API (agent loop interface): Codex CLI uses a configurable Responses API endpoint for model inference; for OpenAI-hosted models via API key, that is `POST /v1/responses`. citeturn8view2 The Responses API supports conversation linking via `previous_response_id` and can allow parallel tool calls (`parallel_tool_calls`). citeturn16view1turn16view0

Anthropic Claude API: Claude is accessed via a REST API at `https://api.anthropic.com`; the primary interface is `POST /v1/messages`. Required headers include `x-api-key` and `anthropic-version`. citeturn9view0turn8view4

### Comparison tables for integration choices

GitHub authentication options (recommended baseline: GitHub App)

| Option | Best for | Strengths | Tradeoffs / risks |
|---|---|---|---|
| GitHub App (installation token) | Automated PR creation/updates, checks, repo-scoped access | Fine-grained permissions; short-lived tokens; not tied to a user; installation token usable with REST+GraphQL; installation token expires after ~1 hour. citeturn0search3turn8view6turn7search3 | Requires JWT generation (RS256) and installation-token exchange plumbing. citeturn7search14turn7search10 |
| Fine-grained PAT | Quick prototypes, single-repo scripts | Easier to start than Apps; can be scoped to repos/permissions (conceptually). citeturn10view2 | Still user-tied; rotation/offboarding risk; least-privilege harder than Apps in practice; secret-handling burden. citeturn10view2turn3search17 |
| OAuth App | User-authorized integrations requiring user context | Standard OAuth flows supported by GitHub; can act on behalf of users. citeturn0search35 | GitHub generally prefers GitHub Apps; less fine-grained and control differs. citeturn0search3 |
| `GITHUB_TOKEN` in Actions | Work done entirely inside GitHub Actions | Simple for in-repo automation; no external secret needed for many cases | Permission limitations can require switching to GitHub App token; also requires careful workflow security. citeturn0search7turn3search17 |

OpenAI Codex integration surfaces

| Surface | Where it fits in this system | Why you’d pick it |
|---|---|---|
| Responses API (`POST /responses`) | Spec generation, planning, structured review output, tool-driven approvals | Codex CLI drives its agent loop via the Responses API; you can build your own loop similarly. citeturn8view2turn8view1 |
| Codex SDK (`@openai/codex-sdk`) | CI/CD automation, headless workflows, repeatable “review bot” steps | Officially positioned for CI/CD and internal tool integration; run threads and continue them. citeturn11view1turn11view0 |
| Codex App Server (JSON-RPC over JSONL on stdio) | Deep embedded UX (approvals, streamed events, conversation history) or building a custom “Codex console” | Protocol supports bidirectional JSON-RPC, streaming events, approvals; open-source implementation is available. citeturn11view0turn7search5 |
| “Codex as MCP server” | Multi-agent workflows where other agents/tools invoke Codex as a tool | OpenAI documents running Codex as an MCP server (`codex mcp-server`) for orchestrated multi-agent workflows. citeturn11view2turn11view3 |

Claude integration surfaces

| Surface | Where it fits | Notes |
|---|---|---|
| Messages API (`POST /v1/messages`) | Core agent execution, tool-use prompting, reasoning over diffs/logs | Canonical Claude API; requires `x-api-key` + `anthropic-version`. citeturn9view0turn8view4 |
| Message Batches API | High-volume asynchronous workloads | Documented as part of the Claude API set for batch processing. citeturn9view0 |

Orchestration frameworks (cloud-agnostic shortlist)

| Framework | Why it’s a good fit for a Ralph loop | Evidence from docs |
|---|---|---|
| Temporal | Durable workflow executions that resume after crashes/failures; rich timeout/retry semantics align with multi-step agent loops | Temporal describes Workflow Executions as durable/reliable/scalable and emphasizes crash-proof execution. citeturn17search4turn17search12 |
| Argo Workflows | Kubernetes-native DAG/step workflows to run many containerized tasks in parallel; explicit retry strategies | Argo positions itself as a container-native workflow engine for parallel jobs on Kubernetes with DAG support and retryStrategy. citeturn17search5turn17search1 |
| Prefect | Pythonic orchestration; tasks/flows are retryable units of work and can run concurrently/parallel | Prefect docs describe tasks as retryable and easy to execute concurrently/parallel. citeturn17search6turn17search2 |
| Dagster | Event/sensor-driven orchestration and automation; good when you want “policy + observability” around job runs | Dagster emphasizes sensors reacting to events and jobs as execution/monitoring units. citeturn17search7turn17search11 |

Recommended default for most teams: Temporal (durable long-running workflows) if you can operate it; Prefect if you want a Python-first control plane with lighter ops; Argo if you are already Kubernetes-native and want containerized steps with DAG parallelism. (This recommendation is an engineering judgment based on the above documented properties.)

## Message formats and formal spec schema

A Ralph loop becomes robust when every major step produces a structured artifact that can be re-consumed in a fresh context. That means you want two categories of “contract”:

Internal event envelopes: what your orchestrator publishes/consumes (webhook → task ingested → spec produced → work dispatched → CI results → review decision).  
Spec schema: the canonical “formal spec” that drives agent execution and validation (acceptance criteria, file targets, test plan, security constraints, stopping criteria).

### Internal event envelope (JSON)

Use a small, versioned envelope so you can evolve fields without breaking workers.

```json
{
  "schema_version": "1.0",
  "event_type": "task.requested",
  "event_id": "evt_01H...",
  "timestamp": "2026-02-11T21:34:12Z",
  "source": {
    "system": "github",
    "repo": "org/repo",
    "delivery_id": "f4b8d2a0-...."
  },
  "actor": {
    "type": "user|bot|system",
    "login": "octocat"
  },
  "task_ref": {
    "kind": "issue|project_item|workflow_dispatch",
    "id": 1234,
    "url": "..."
  },
  "payload": {
    "title": "Implement rate limiter",
    "body_markdown": "...",
    "labels": ["ai-ready", "backend"],
    "priority": "P1"
  }
}
```

The `delivery_id` aligns well with GitHub’s webhook delivery identifiers (GitHub includes `X-GitHub-Delivery` headers as a unique GUID for deliveries). citeturn1search6

### Formal spec schema (YAML)

This is the artifact Codex (spec generator) produces and Claude agents execute. Keep it small enough to fit frequently into prompts, but complete enough to be the source of truth.

```yaml
spec_version: 1
spec_id: spec_2026_02_11_001
source:
  github:
    repo: org/repo
    issue: 1234
    commit_baseline: abcdef123456
objective: >
  Add a token-bucket rate limiter to /api/v1/login to mitigate brute force.
non_goals:
  - Do not introduce a new external dependency heavier than X
constraints:
  languages: [typescript]
  allowed_paths:
    - src/
    - tests/
  forbidden_paths:
    - infra/
acceptance_criteria:
  - "Requests above 10/minute per IP return HTTP 429"
  - "Rate limit resets within 60 seconds"
  - "All existing tests pass"
  - "Add new tests covering bursts and reset behavior"
design_notes:
  api_contract:
    endpoint: POST /api/v1/login
    response_on_limit:
      status: 429
      body_json: { "error": "rate_limited" }
work_breakdown:
  - id: T1
    title: "Implement limiter middleware"
    owner_role: "claude-agent-backend"
    definition_of_done:
      - "Unit tests added"
  - id: T2
    title: "Wire into router + docs"
    owner_role: "claude-agent-integration"
    depends_on: [T1]
risk_checks:
  - "No secrets added"
  - "No PII logged"
validation_plan:
  ci_jobs:
    - "unit"
    - "lint"
    - "typecheck"
    - "security_scan"
stop_conditions:
  - "CI green"
  - "LLM review: pass"
  - "No open 'request changes' reviews"
```

Why this shape works for Ralph loops: each iteration can include only (a) this spec, (b) current repo diff/PR state, (c) CI outputs—without carrying forward a long chat transcript. That matches the “fresh context each loop; external state persists progress” requirement. citeturn14view1

### Agent output schema (JSON)

Require Claude agents to emit structured outputs so the orchestrator can automatically route results.

```json
{
  "task_id": "T1",
  "status": "completed|blocked|needs_review",
  "summary": "Implemented token bucket middleware with in-memory store.",
  "diff_plan": {
    "files_changed": ["src/middleware/rateLimit.ts", "tests/rateLimit.test.ts"],
    "migration_needed": false
  },
  "commands_ran": [
    {"cmd": "npm test", "exit_code": 0}
  ],
  "open_questions": [],
  "handoff_notes": "If we later need distributed rate limiting, swap store for Redis."
}
```

The orchestrator can reject outputs that are not valid JSON or that violate policy (e.g., claims tests passed without logs), then schedule a retry iteration.

## Orchestration patterns, validation, and PR automation

### Task splitting, parallelism, retries, and state management

A Ralph loop is most effective when you keep the unit of work small and measurable, and keep the iteration boundaries hard:

Split work by “mergeable increments”: prefer tasks that can be landed independently behind flags, or as refactors + feature additions.  
Parallelize only where dependencies are explicit: e.g., documentation and tests can proceed in parallel with implementation, but schema changes might block everything else.  
Use bounded retries with backoff: distinguish transient failures (timeouts, flaky CI) from deterministic failures (compile errors).  
Treat the repo + spec + CI artifacts as the canonical state; the orchestration DB should store pointers/hashes to those artifacts, not re-embed everything into prompts.

OpenAI Responses API supports enabling/disabling parallel tool calls (`parallel_tool_calls`), which is useful if you are using tool calling for “run tests”, “search code”, etc., and want the model to issue multiple tool calls at once. citeturn16view0 If you instead implement orchestration in your own service (recommended), you can manage parallelism at the workflow layer (e.g., concurrently dispatching independent sub-tasks to multiple Claude workers).

Concrete orchestration loop (high level):

Ingest: receive GitHub event; verify signature; map to internal TaskRequested. citeturn10view0turn8view5  
Spec: call Codex to generate/update `spec.yaml`.  
Plan: compute a DAG of work items (`work_breakdown`) and enqueue ready nodes.  
Execute: Claude workers open ephemeral workspaces at the baseline commit, apply changes, run local checks, and push to a branch.  
Integrate: create or update a PR via GitHub REST API (pulls endpoints exist to create/manage/merge PRs). citeturn5search2turn7search22  
Validate: CI runs required checks; results return to orchestrator; repeat for failures. Required checks can be enforced by branch protection / rulesets. citeturn1search11turn2search13  
Review: run LLM review (Codex) over diff + test logs; optionally request human review; then satisfy merge rules.

### Validation and review loop

GitHub provides two key primitives for gating merges:

Status checks / checks: if required checks are configured, they must pass before merging into a protected branch. citeturn1search11turn1search7  
Reviews: branch protection can require approving reviews; CODEOWNERS can auto-request reviews on modified code paths. citeturn2search6turn2search2

Automated validation stack (recommended order):

Deterministic gates first: unit/integration tests, lint, typecheck, formatting, dependency/security scanning.  
Static analysis / SAST: run CodeQL or equivalent (tool choice varies); treat findings as blockers for autonomous merge.  
LLM-based review second: only after deterministic checks pass, run Codex-based review to flag style, correctness risks, missing edge cases.

OpenAI explicitly documents building a code review action using Codex CLI headless mode in CI/CD runners (including GitHub Actions and Jenkins), suggesting a practical path for an automated LLM review gate. citeturn8view3

Human-in-the-loop options:

“Approval required” mode: LLM review posts comments, but a human must approve/merge.  
Escalation mode: autonomous merge allowed only for low-risk changes (docs, refactors with no behavior change) and only when no review comments request changes; higher-risk specs require human approval.  
CODEOWNERS enforcement: require code owner approvals for certain directories. citeturn2search2turn2search6

### PR automation details

Branching strategy:

Create a dedicated branch per spec execution attempt: `ai/spec_2026_02_11_001/attempt_3`.  
Force-push is discouraged; prefer incremental commits so review tools can attribute changes and CI can diagnose regressions.

Commit signing:

If you enable “require signed commits” (via rulesets or branch protection), bots and contributors can only push commits that are signed and verified. citeturn10view1turn2search21 This is good defense-in-depth for autonomous systems, but it requires your bot to sign commits (GPG/SSH/S/MIME depending on org policy). citeturn2search21turn2search13

Merge rules and merge queue:

Branch protection rules can enforce reviews, status checks, signed commits, and can require merge queue. citeturn2search27turn1search3 With merge queue, GitHub can merge PRs once required checks pass on the queued merge group. citeturn2search8turn7search29 If your required checks run on GitHub Actions, update workflows to also trigger on `merge_group` events; otherwise checks won’t run for merge queue entries and merges will fail. citeturn8view7turn2search0

Checks API note:

If you plan to create “check runs” (richer than simple commit statuses) from your orchestration service, GitHub notes that write permission for the Checks API is only available to GitHub Apps (OAuth apps and users can view but not create). citeturn2search3turn2search7 This is another reason to choose GitHub App auth.

## Security, compliance, and observability

### Secrets management and least privilege

GitHub Actions secrets: GitHub describes secrets as sensitive variables stored at org/repo/environment scope; Actions can only read a secret if included in a workflow, and secrets are encrypted using Libsodium sealed boxes (encrypted before reaching GitHub). citeturn10view2

OpenAI API keys: OpenAI recommends not exposing API keys in code or public repos and using environment variables or a secret management service instead. citeturn3search3turn8view0

GitHub Apps vs PAT: GitHub Apps are preferred over OAuth apps because of fine-grained permissions, better repo access control, and short-lived tokens, which limits damage if credentials leak. citeturn0search3turn10view2 GitHub App installation tokens expire after one hour, forcing rotation by design. citeturn8view6

Recommended secret architecture (cloud-agnostic):

Store OpenAI/Anthropic keys and GitHub App private keys in a dedicated secrets manager (Vault/KMS-backed secret store); inject into orchestrator/runner at runtime.  
Use separate credentials per environment (dev/staging/prod) and per function (spec-gen vs review vs PR writer) to enforce least privilege.  
For CI, prefer OIDC-based short-lived cloud creds (where applicable) and GitHub App tokens over long-lived PATs.

Leak prevention:

Enable secret scanning and push protection to prevent agent-generated code from accidentally committing secrets. GitHub describes push protection as proactively scanning during pushes and blocking pushes containing detected secrets. citeturn10view3turn6search23

### Data retention and compliance considerations

OpenAI data controls: OpenAI states that, as of March 1, 2023, data sent to the OpenAI API is not used to train or improve OpenAI models unless you opt in, and notes that abuse monitoring logs may be retained up to 30 days by default, with “Zero Data Retention” or modified controls available for eligible customers. citeturn12view0 OpenAI also describes enterprise privacy commitments including “We do not train on your data by default” and references SOC 2 and encryption at rest/in transit. citeturn12view1turn3search24

Anthropic compliance posture: Anthropic’s Trust Center advertises compliance artifacts and notes completion of assessments such as NIST 800-171 for Claude services. citeturn3search2turn6search2 Anthropic also describes an enterprise “Compliance API” for programmatic access to usage data/content for monitoring and policy enforcement (enterprise feature). citeturn6search10turn3search30

GitHub auditability: GitHub provides audit logs at org/enterprise levels and notes webhooks can be an efficient alternative to polling audit logs for tracking events. citeturn6search12turn6search0

Practical compliance guidance for this system:

Classify data: specs and PR diffs may include proprietary code—treat them as regulated internal artifacts and store with encryption + access control.  
Minimize data to LLMs: send only the diff context needed (file snippets around changed areas, failing test output, spec).  
Retain evidence: keep immutable logs of what the system changed, why, and which checks passed, for auditability and incident response.

### Error handling and observability

Observability should make the loop debuggable at three levels: event ingestion, agent execution, and merge gating.

Instrument with traces/metrics/logs:

OpenTelemetry is a vendor-neutral framework for generating and exporting telemetry (traces, metrics, logs). citeturn18search0turn18search12 Prometheus is a widely used open-source monitoring system for scraping metrics and alerting, often paired with dashboards (Grafana or similar). citeturn18search5turn18search1

Minimum recommended signals:

Structured logs: webhook delivery_id, task_id/spec_id, attempt number, PR number, CI run URLs, LLM request ids (if exposed), and final decision.  
Metrics: loop latency, attempts per task, CI pass rate, LLM token usage per phase, rollback rate, and “human escalation” frequency.  
Alerts: high failure rate on CI, webhook verification failures, GitHub API rate limit errors, repeated LLM timeouts, unauthorized secret detection (push protection blocks).

Use audit logs where available:

OpenAI exposes an Audit Logs API (organization-level) for “user actions and configuration changes,” which requires enabling logging in Data Controls settings (and then cannot be disabled for security reasons). citeturn6search1turn12view2 This is useful for tracking key changes: key creation, role changes, etc., when operating a production-grade autonomous system.

## Implementation roadmap, key snippets, and staging/testing plan

### Key integration snippets (pseudocode)

Webhook handler (verify signature, enqueue event)

GitHub’s docs provide a concrete approach using Octokit’s `@octokit/webhooks` library and `X-Hub-Signature-256` verification. citeturn10view0turn8view5

```ts
// Express-style pseudocode
import { Webhooks } from "@octokit/webhooks";

const webhooks = new Webhooks({ secret: process.env.GITHUB_WEBHOOK_SECRET });

async function handleWebhook(req, res) {
  const sig = req.headers["x-hub-signature-256"];
  const body = await req.text();              // important: raw body
  const ok = await webhooks.verify(body, sig);
  if (!ok) return res.status(401).send("bad signature");

  const evtType = req.headers["x-github-event"];
  const delivery = req.headers["x-github-delivery"];
  const payload = JSON.parse(body);

  // Map GitHub event -> internal event envelope
  enqueue({
    schema_version: "1.0",
    event_type: `github.${evtType}`,
    event_id: `gh_${delivery}`,
    payload
  });

  res.status(202).send("accepted");
}
```

Codex spec generation (Responses API shape)

Codex CLI uses the Responses API for inference, and OpenAI highlights the `instructions`, `tools`, and `input` fields as key payload elements. citeturn8view2turn8view1

```python
def generate_spec_with_codex(task_text, repo_context_snippets) -> str:
    prompt = f"""
    Convert the following GitHub task into a formal spec YAML.
    Include: objective, non_goals, constraints, acceptance_criteria,
    work_breakdown with dependencies, validation_plan, stop_conditions.

    Task:
    {task_text}

    Repo context:
    {repo_context_snippets}
    """.strip()

    # POST /v1/responses ... (pseudo)
    resp = openai.responses.create(
        model="gpt-5.x-codex",
        instructions="You are a strict software spec writer. Output YAML only.",
        input=[{"role": "user", "content": prompt}],
    )
    return resp.output_text
```

The system should validate the YAML against a JSON Schema (your own) before accepting the spec.

Claude agent execution (Messages API)

Claude API requires `x-api-key` and `anthropic-version` headers; the primary API is Messages (`POST /v1/messages`). citeturn9view0turn8view4

```python
def run_claude_agent(subtask, spec, diff_context, tool_summaries) -> dict:
    system = "You are a coding agent. Follow the spec exactly. Output JSON per schema."
    user = {
        "role": "user",
        "content": f"""
        Subtask: {subtask}

        Spec:
        {spec}

        Current diff context:
        {diff_context}

        Tool summaries (tests/lint):
        {tool_summaries}

        Return JSON with fields: task_id, status, summary, files_changed, commands_ran.
        """.strip()
    }

    msg = anthropic.messages.create(
        model="claude-opus-4-6",
        max_tokens=2048,
        messages=[user],
        # headers handled by SDK: x-api-key, anthropic-version
    )
    return parse_json(msg.content[0].text)
```

Automated LLM code review in CI

OpenAI provides a cookbook showing how to build a Codex-based code review action using Codex CLI headless mode in GitHub Actions/Jenkins. citeturn8view3 In a Ralph loop, you typically run this only after deterministic checks pass, then post review comments or a “pass/fail” check.

High-level steps:

Compute diff vs base branch.  
Feed diff + spec + CI summaries into Codex review prompt.  
Emit: (a) PR review comments, (b) a checks API result, or (c) a “required status check” output. (To create check runs, use a GitHub App.) citeturn2search3turn2search26

### Testing strategy and staging plan

A safe rollout should follow “increasing autonomy” phases:

Phase zero: Dry-run mode  
Ingest real GitHub tasks but do not push commits; only generate specs and post them as issue comments for human review. (Use GitHub Issues/Comments endpoints as needed.) citeturn5search1turn5search17

Phase one: PR-only mode (no auto-merge)  
Allow Claude agents to push branches and open PRs, but require human approvals and required checks. Branch protection rules can enforce required reviews and status checks. citeturn1search3turn1search11

Phase two: Limited-scope auto-merge  
Enable auto-merge only for low-risk labels (docs, non-prod tooling) and only when CI is green and LLM review passes with no “request changes”.

Phase three: Full workflow with merge queue  
When concurrency rises, enable merge queue so PRs are merged in a controlled, serialized manner against the latest target branch, ensuring required checks pass in-queue. citeturn2search8turn7search29 Ensure Actions workflows trigger on `merge_group`. citeturn8view7

Testing layers:

Unit tests: webhook verification, GitHub API client wrappers, schema validators.  
Integration tests: end-to-end “issue labeled ai-ready → spec generated → PR created → CI results captured” using a sandbox GitHub org/repo.  
Load tests: burst webhook deliveries and rate limit handling (GitHub + LLM APIs).  
Security tests: prompt injection simulations in issue bodies/comments; secret leakage tests with push protection enabled. citeturn10view3

### Failure modes and mitigations

Spec drift / underspecified acceptance criteria: mitigated by schema validation + spec review gate (human or LLM) before dispatch; require explicit acceptance_criteria and validation_plan.  
Hallucinated “tests passed”: require captured CI artifacts and command logs; accept “pass” only when GitHub required checks pass. citeturn1search11turn1search19  
Merge queue misconfiguration: if workflows don’t run on `merge_group`, queue merges fail because required checks aren’t reported. Mitigation: add `merge_group` triggers. citeturn8view7  
Credential leakage: mitigate with secret scanning and push protection; reduce scope via GitHub Apps and short-lived tokens; store secrets in managers, not repos. citeturn10view3turn0search3turn3search3  
Webhook spoofing or replay: verify signatures; store delivery IDs and enforce idempotency keyed by `X-GitHub-Delivery`. citeturn10view0turn1search6  
Tool/command abuse by agents: run in sandboxed workspaces with allowlisted commands; require approvals for privileged actions. Codex tooling surfaces approvals as a first-class concern (App Server) if you adopt that harness-style integration. citeturn11view0turn8view2  
Rate limits/timeouts: implement retries with jitter/backoff; separate transient errors from deterministic failures; use workflow engines that support retries/timeouts durably (Temporal/Argo/Prefect patterns). citeturn17search0turn17search1turn17search2

### Recommended end-to-end implementation plan

Milestones are ordered by “make it safe, then make it fast.” Effort is relative (low/medium/high) assuming an experienced platform engineer plus one applications engineer.

| Milestone | Deliverable | Priority | Effort | Notes |
|---|---|---:|---:|---|
| Orchestration foundation | Webhook ingestion + signature verification + event log + state store | P0 | Medium | Use `X-Hub-Signature-256` verification as per GitHub guidance. citeturn10view0turn8view5 |
| GitHub App integration | GitHub App auth, installation token rotation, PR create/update client | P0 | Medium | Installation token expires after 1 hour; use Octokit to simplify rotation. citeturn8view6turn7search3 |
| Spec generation | Codex-based spec generator + schema validation + spec posting to GitHub | P0 | Medium | Codex CLI uses Responses API; you can implement via Responses API or Codex SDK. citeturn8view2turn11view1 |
| Agent execution pool | Claude Messages API workers + sandboxed repo workspaces + artifact capture | P0 | High | Claude Messages endpoint and required headers are well-defined. citeturn9view0turn8view4 |
| CI + gates | Required checks + branch protection/rulesets + LLM review gate | P1 | Medium | Required status checks enforced by protected branches; Checks API writes require GitHub Apps. citeturn1search11turn2search3 |
| Merge automation | Merge queue rollout + `merge_group` CI triggers + controlled auto-merge policies | P1 | Medium | Must add `merge_group` triggers if using Actions for required checks. citeturn8view7turn2search8 |
| Security hardening | Secret scanning + push protection + least privilege review + audit logging | P1 | Medium | Push protection blocks secret pushes; GitHub Apps reduce blast radius. citeturn10view3turn0search3 |
| Observability and incident response | Tracing/metrics/logs + alerting + runbooks | P2 | Medium | OpenTelemetry provides vendor-neutral telemetry for traces/metrics/logs. citeturn18search0turn18search12 |

Primary/official documentation referenced throughout includes GitHub webhooks + branch protections + merge queue, OpenAI Responses/Codex SDK/App Server materials, and Anthropic Claude API overview (all cited inline).