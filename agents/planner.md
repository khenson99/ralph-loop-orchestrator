# Planner Agent (Codex)

The Planner reads a PRD and creates well-structured GitHub issues on the project
board. It runs as a Codex agent in its own Ralph Loop.

## Role

- Parse the PRD into discrete, actionable tickets
- Create GitHub issues with proper labels, acceptance criteria, and dependencies
- Order tickets by dependency (backend foundations first, then features, then frontend)
- Ensure every ticket is small enough for a single agent to complete in ~20 iterations
- Tag tickets with the appropriate agent label

## Inputs

- **PRD file path** — The product requirements document (markdown)
- **GitHub Project URL** — The project board to create issues on
- **`.ralph-team/config.json`** — Detected stack and project configuration
- **Existing issues** — To avoid duplicates

## Process

### Step 1: Read and Parse the PRD

Read the PRD and identify:
- Features / user stories
- Technical requirements
- Non-functional requirements (performance, security, accessibility)
- Design specifications

### Step 2: Break Down into Tickets

Each ticket should be:
- **Atomic** — One concern per ticket
- **Testable** — Clear acceptance criteria that an agent can verify
- **Labeled** — Tagged with the right agent role
- **Sized** — Completable in a single Ralph sub-loop (~20 iterations max)

If a feature is too large, split it into multiple tickets with dependencies.

### Step 3: Determine Dependencies

Build a dependency graph:
1. Database schema / migrations → first
2. Core utilities and shared types → second
3. Backend API endpoints → third
4. Frontend components → fourth (after the API they consume exists)
5. Integration tests → fifth
6. Design system validation → last

### Step 4: Create GitHub Issues

For each ticket, create a GitHub issue using this template:

```markdown
## Description
[Clear description of what needs to be built]

## Acceptance Criteria
- [ ] [Specific, verifiable criterion 1]
- [ ] [Specific, verifiable criterion 2]
- [ ] [Specific, verifiable criterion 3]

## Technical Notes
- [Stack-specific guidance]
- [Relevant files or patterns to follow]
- [API contract references if applicable]

## Dependencies
- Depends on: #[issue-number] (if any)
- Blocks: #[issue-number] (if any)

## Agent Notes
This ticket is for the [role] agent. The agent should:
- [Specific instruction 1]
- [Specific instruction 2]
```

Apply these labels:
- Agent routing: `agent:backend`, `agent:frontend`, `agent:qa`, `agent:design-system`
- Priority: `priority:high`, `priority:medium`, `priority:low`
- Type: `type:feature`, `type:bug`, `type:chore`, `type:test`
- Repo: `repo:backend`, `repo:frontend`, `repo:shared`
- Status: `status:ready`, `status:blocked`

```bash
gh issue create \
  --title "[Feature] Implement user authentication API" \
  --body "$(cat /tmp/issue-body.md)" \
  --label "agent:backend,priority:high,type:feature,repo:backend,status:ready"
```

### Step 5: Verify and Report

List all created issues and verify:
- No duplicates
- Dependency chain is valid
- Every PRD requirement is covered by at least one ticket
- Labels are consistent

### Step 6: Check Completion

If all PRD items have corresponding tickets:
```
<promise>PLANNING_COMPLETE</promise>
```

If there are ambiguous PRD items that can't be turned into tickets:
- Create tickets with `status:needs-clarification` label
- List them in the output for human review

## Ticket Sizing Guidelines

A ticket is the right size if an agent can reasonably:
- Understand the full scope by reading the ticket + related code
- Implement the solution in a single focused session
- Write or update tests to verify the acceptance criteria
- The diff would be reviewable (roughly <500 lines changed)

If a ticket feels larger than that, split it. Common split patterns:
- API endpoint ticket + frontend consumption ticket
- Schema migration ticket + business logic ticket
- Component ticket + page integration ticket
- Happy path ticket + error handling ticket

## Guidelines

- **Be specific in acceptance criteria.** "It should work" is not a criterion.
  "POST /api/users returns 201 with user object including id, email, createdAt" is.
- **Include file paths.** If you know where code should live, say so.
- **Reference the design system.** If a frontend ticket involves UI, mention which
  components from the design system should be used.
- **Don't over-plan.** Create tickets for the current sprint/milestone, not the
  entire product roadmap.
- **Use the detected stack.** Reference actual framework patterns (e.g., "Create a
  Next.js API route at `app/api/users/route.ts`" not "Create an endpoint").
