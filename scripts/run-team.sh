#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# run-team.sh — Run the Claude Code agent team in a Ralph Loop
#
# The Architect orchestrates: reads tickets, assigns to agents, each agent
# runs its own sub-loop until ticket completion or max iterations.
#
# Usage:
#   ./scripts/run-team.sh [--max-iterations 20]
# =============================================================================

MAX_ITERATIONS=20
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="$SCRIPT_DIR/../agents"
FORBIDDEN_PR_COMMAND_REGEX='(^|[[:space:]])gh[[:space:]]+pr[[:space:]]+(merge|close|review)([[:space:]]|$)'
CLAUDE_MODEL="${CLAUDE_MODEL:-claude-opus-4-6}"
CLAUDE_EFFORT="${CLAUDE_EFFORT:-high}"
CLAUDE_PERMISSION_MODE="${CLAUDE_PERMISSION_MODE:-plan}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --max-iterations) MAX_ITERATIONS="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ ! -f ".ralph-team/config.json" ]]; then
  echo "Error: .ralph-team/config.json not found. Run init.sh first."
  exit 1
fi

if [[ -f "scripts/validate-state.ts" ]]; then
  npm run --silent ralph:validate-state
fi

REPO_TYPE=$(jq -r '.repo_type' .ralph-team/config.json)
DETECTED_STACK=$(jq -c '.detected_stack' .ralph-team/config.json)

echo "🏗️  Starting Team Loop (Claude Code)"
echo "   Repo type: $REPO_TYPE"
echo "   Max iterations: $MAX_ITERATIONS"
echo "   Claude model: $CLAUDE_MODEL (effort: $CLAUDE_EFFORT, mode: $CLAUDE_PERMISSION_MODE)"

find_linked_open_prs_for_ticket() {
  local ticket_number="$1"
  gh pr list --state open --json number,title,body,headRefName --limit 200 2>/dev/null | \
    jq --arg tn "$ticket_number" '
      [
        .[] |
        select(
          ((.body // "") | test("(?i)(closes|fixes|resolves)\\s+#" + $tn + "\\b")) or
          ((.headRefName // "") | test("(^|[/_-])issue-" + $tn + "($|[/_-])")) or
          ((.title // "") | test("#" + $tn + "\\b"))
        )
      ]
    ' 2>/dev/null || echo "[]"
}

# ── Agent Sub-Loop ──────────────────────────────────────────────────────────
# Runs a single agent on a single ticket in a Ralph sub-loop
run_agent() {
  local AGENT_ROLE="$1"
  local TICKET_NUMBER="$2"
  local AGENT_MAX_ITERATIONS="${3:-$MAX_ITERATIONS}"
  local AGENT_SPEC="$AGENTS_DIR/${AGENT_ROLE}.md"

  if [[ ! -f "$AGENT_SPEC" ]]; then
    echo "  ⚠️  No agent spec found for: $AGENT_ROLE"
    return 1
  fi

  echo "  🤖 Starting $AGENT_ROLE agent on ticket #$TICKET_NUMBER"

  local AGENT_ITERATION=0

  while [[ $AGENT_ITERATION -lt $AGENT_MAX_ITERATIONS ]]; do
    AGENT_ITERATION=$((AGENT_ITERATION + 1))
    echo "    ── $AGENT_ROLE iteration $AGENT_ITERATION / $AGENT_MAX_ITERATIONS ──"

    # Build the agent's task context
    local TASK_FILE=".ralph-team/current-tasks/${AGENT_ROLE}.json"
    local AGENT_KNOWLEDGE=".ralph-team/agents/${AGENT_ROLE}.md"
    local PROGRESS_TAIL=""
    PROGRESS_TAIL=$(tail -50 .ralph-team/progress.txt 2>/dev/null || echo "No progress yet")

    local TICKET_BODY=""
    TICKET_BODY=$(gh issue view "$TICKET_NUMBER" --json body,title,labels -q '.title + "\n\n" + .body' 2>/dev/null || echo "Could not fetch ticket")

    PROMPT=$(cat << AGENT_PROMPT_EOF
You are the $AGENT_ROLE agent in a Ralph Team Loop.

## Your Role
$(cat "$AGENT_SPEC")

## Your Assignment
Ticket #$TICKET_NUMBER:
$TICKET_BODY

## Context
- Repo type: $REPO_TYPE
- Detected stack: $DETECTED_STACK
- Iteration: $AGENT_ITERATION of $AGENT_MAX_ITERATIONS

## Accumulated Knowledge
$(cat "$AGENT_KNOWLEDGE" 2>/dev/null || echo "No accumulated knowledge yet")

## Recent Progress
$PROGRESS_TAIL

## Instructions
1. Read your assignment and role specification above
2. Scan the codebase to understand existing patterns
3. Do the work described in your role specification
4. When done, output <promise>TICKET_DONE</promise>
5. If blocked, output <promise>BLOCKED</promise> with a reason
6. Update .ralph-team/progress.txt with your learnings
7. Update .ralph-team/agents/${AGENT_ROLE}.md with discovered patterns
8. Do NOT run any reviewer-only PR commands: gh pr review, gh pr merge, or gh pr close
9. Non-reviewer agents may open/update PRs, but only the Reviewer agent can approve, request changes, merge, or close PRs
AGENT_PROMPT_EOF
    )

    # Run Claude Code
    local OUTPUT=""
    OUTPUT=$(claude -p \
      --model "$CLAUDE_MODEL" \
      --permission-mode "$CLAUDE_PERMISSION_MODE" \
      --effort "$CLAUDE_EFFORT" \
      --dangerously-skip-permissions \
      "$PROMPT" 2>&1) || true

    # Enforce non-reviewer policy in wrapper
    if echo "$OUTPUT" | grep -Eiq "$FORBIDDEN_PR_COMMAND_REGEX"; then
      local POLICY_REASON="Policy violation: non-reviewer agents must not run gh pr review/merge/close."
      echo "    🚫 $AGENT_ROLE violated PR policy on ticket #$TICKET_NUMBER"
      echo "$POLICY_REASON"

      jq --arg tn "$TICKET_NUMBER" --arg role "$AGENT_ROLE" --arg reason "$POLICY_REASON" \
        '.tickets[$tn].status = "blocked" | .tickets[$tn].blocked_reason = $reason | .agents[$role].status = "idle" | .agents[$role].current_ticket = null' \
        .ralph-team/team-state.json > /tmp/team-state-tmp.json && \
        mv /tmp/team-state-tmp.json .ralph-team/team-state.json

      echo "--- Guardrail Violation ---" >> .ralph-team/progress.txt
      echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .ralph-team/progress.txt
      echo "Agent: $AGENT_ROLE" >> .ralph-team/progress.txt
      echo "Ticket: #$TICKET_NUMBER" >> .ralph-team/progress.txt
      echo "Reason: $POLICY_REASON" >> .ralph-team/progress.txt
      echo "" >> .ralph-team/progress.txt

      return 2
    fi

    # Check for completion
    if echo "$OUTPUT" | grep -q "<promise>TICKET_DONE</promise>"; then
      local LINKED_OPEN_PRS=""
      local LINKED_PR_COUNT=""
      local PRIMARY_PR_NUM=""
      LINKED_OPEN_PRS=$(find_linked_open_prs_for_ticket "$TICKET_NUMBER")
      LINKED_PR_COUNT=$(echo "$LINKED_OPEN_PRS" | jq 'length' 2>/dev/null || echo "0")

      if [[ "$LINKED_PR_COUNT" == "0" ]]; then
        echo "    ⚠️  $AGENT_ROLE reported TICKET_DONE, but no open PR linked to ticket #$TICKET_NUMBER was found."
        echo "    ... continuing agent loop; ticket cannot move to reviewer without an open linked PR."
        echo "Guardrail: ticket #$TICKET_NUMBER marked done without open linked PR at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .ralph-team/progress.txt
        sleep 1
        continue
      fi

      PRIMARY_PR_NUM=$(echo "$LINKED_OPEN_PRS" | jq -r '.[0].number // empty')
      echo "    ✅ $AGENT_ROLE completed ticket #$TICKET_NUMBER with linked open PR #$PRIMARY_PR_NUM (iteration $AGENT_ITERATION)"

      # Update team state
      jq --arg tn "$TICKET_NUMBER" --arg role "$AGENT_ROLE" --argjson pr "$PRIMARY_PR_NUM" --arg reviewed_at "" \
        '.tickets[$tn].status = "pr-open" | .tickets[$tn].pr_number = $pr | .tickets[$tn].reviewed = false | .tickets[$tn].review_decision = null | .tickets[$tn].reviewed_at = $reviewed_at | .agents[$role].status = "idle" | .agents[$role].current_ticket = null' \
        .ralph-team/team-state.json > /tmp/team-state-tmp.json && \
        mv /tmp/team-state-tmp.json .ralph-team/team-state.json

      return 0
    fi

    if echo "$OUTPUT" | grep -q "<promise>BLOCKED</promise>"; then
      local REASON=""
      REASON=$(echo "$OUTPUT" | grep -A1 "BLOCKED" | tail -1)
      echo "    🚫 $AGENT_ROLE blocked on ticket #$TICKET_NUMBER: $REASON"

      jq --arg tn "$TICKET_NUMBER" --arg role "$AGENT_ROLE" --arg reason "$REASON" \
        '.tickets[$tn].status = "blocked" | .tickets[$tn].blocked_reason = $reason | .agents[$role].status = "idle" | .agents[$role].current_ticket = null' \
        .ralph-team/team-state.json > /tmp/team-state-tmp.json && \
        mv /tmp/team-state-tmp.json .ralph-team/team-state.json

      return 2
    fi

    echo "    ... $AGENT_ROLE still working (iteration $AGENT_ITERATION)"
    sleep 1
  done

  echo "    ⚠️  $AGENT_ROLE hit max iterations on ticket #$TICKET_NUMBER"
  return 1
}

# ── Architect Loop ──────────────────────────────────────────────────────────
ARCHITECT_ITERATION=0

while [[ $ARCHITECT_ITERATION -lt $MAX_ITERATIONS ]]; do
  ARCHITECT_ITERATION=$((ARCHITECT_ITERATION + 1))
  echo ""
  echo "━━━ Architect Iteration $ARCHITECT_ITERATION / $MAX_ITERATIONS ━━━"

  # Run the Architect to assess state and assign work
  ARCHITECT_PROMPT=$(cat << ARCH_PROMPT_EOF
You are the Architect agent in a Ralph Team Loop. You orchestrate the team.

## Your Role
$(cat "$AGENTS_DIR/architect.md")

## Current Team State
$(cat .ralph-team/team-state.json)

## Open Issues
$(gh issue list --state open --json number,title,labels,assignees --limit 100 2>/dev/null || echo "No open issues")

## Open PRs
$(gh pr list --state open --json number,title,labels,reviewDecision --limit 50 2>/dev/null || echo "No open PRs")

## Recent Progress
$(tail -50 .ralph-team/progress.txt 2>/dev/null || echo "No progress yet")

## Accumulated Knowledge
$(cat .ralph-team/agents/architect.md 2>/dev/null || echo "No accumulated knowledge")

## Context
- Repo type: $REPO_TYPE
- Detected stack: $DETECTED_STACK
- Iteration: $ARCHITECT_ITERATION of $MAX_ITERATIONS

## Instructions
You must output a JSON action plan. Respond with ONLY valid JSON:

{
  "assignments": [
    {"ticket": 42, "agent": "backend-engineer", "notes": "implement the user API"},
    {"ticket": 43, "agent": "frontend-engineer", "notes": "build the login page"}
  ],
  "unblock_actions": [
    {"ticket": 44, "action": "create prerequisite ticket for DB schema"}
  ],
  "decisions": [
    {"title": "ADR-001: Use JWT for auth", "context": "...", "decision": "..."}
  ],
  "sprint_complete": false,
  "sprint_blocked": false,
  "summary": "Assigned 2 tickets. Backend API first, then frontend."
}

If all tickets are done: set sprint_complete to true.
If all remaining tickets are blocked: set sprint_blocked to true.
ARCH_PROMPT_EOF
  )

  ARCHITECT_OUTPUT=$(claude -p \
    --model "$CLAUDE_MODEL" \
    --permission-mode "$CLAUDE_PERMISSION_MODE" \
    --effort "$CLAUDE_EFFORT" \
    --dangerously-skip-permissions \
    "$ARCHITECT_PROMPT" 2>&1) || true

  # Try to parse the Architect's JSON output
  ACTION_PLAN=$(echo "$ARCHITECT_OUTPUT" | grep -Eo '\{[^}]*("assignments"|"sprint_complete")[^}]*\}' | head -1 || echo "")

  # If we can't parse structured output, try to extract it from the full response
  if [[ -z "$ACTION_PLAN" ]]; then
    ACTION_PLAN=$(echo "$ARCHITECT_OUTPUT" | python3 -c "
import sys, json, re
text = sys.stdin.read()
# Find JSON block
match = re.search(r'\{[\s\S]*\"assignments\"[\s\S]*\}', text)
if match:
    try:
        parsed = json.loads(match.group())
        print(json.dumps(parsed))
    except:
        print('{}')
else:
    print('{}')
" 2>/dev/null || echo "{}")
  fi

  # Check for sprint completion
  SPRINT_COMPLETE=$(echo "$ACTION_PLAN" | jq -r '.sprint_complete // false' 2>/dev/null || echo "false")
  SPRINT_BLOCKED=$(echo "$ACTION_PLAN" | jq -r '.sprint_blocked // false' 2>/dev/null || echo "false")

  if [[ "$SPRINT_COMPLETE" == "true" ]]; then
    echo ""
    echo "🎉 Sprint complete! All tickets are done."
    echo "--- Sprint Complete ---" >> .ralph-team/progress.txt
    echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .ralph-team/progress.txt
    echo "Architect iterations: $ARCHITECT_ITERATION" >> .ralph-team/progress.txt
    echo "" >> .ralph-team/progress.txt
    exit 0
  fi

  if [[ "$SPRINT_BLOCKED" == "true" ]]; then
    echo ""
    echo "🚫 Sprint blocked. All remaining tickets have unresolved dependencies."
    echo "--- Sprint Blocked ---" >> .ralph-team/progress.txt
    echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .ralph-team/progress.txt
    echo "" >> .ralph-team/progress.txt
    exit 2
  fi

  # Execute assignments
  ASSIGNMENTS=$(echo "$ACTION_PLAN" | jq -c '.assignments // []' 2>/dev/null || echo "[]")
  NUM_ASSIGNMENTS=$(echo "$ASSIGNMENTS" | jq 'length' 2>/dev/null || echo "0")

  if [[ "$NUM_ASSIGNMENTS" -gt 0 ]]; then
    echo "  📝 Architect assigned $NUM_ASSIGNMENTS tickets"

    echo "$ASSIGNMENTS" | jq -c '.[]' | while read -r assignment; do
      TICKET=$(echo "$assignment" | jq -r '.ticket')
      AGENT=$(echo "$assignment" | jq -r '.agent')
      NOTES=$(echo "$assignment" | jq -r '.notes')

      echo ""
      echo "  ─── Dispatching $AGENT for ticket #$TICKET ───"
      echo "  Notes: $NOTES"

      # Map agent name to spec file
      AGENT_SPEC_NAME="$AGENT"

      # Update team state
      jq --arg tn "$TICKET" --arg agent "$AGENT" \
        '.tickets[$tn] = {"status": "in-progress", "agent": $agent} | .agents[$agent].status = "working" | .agents[$agent].current_ticket = ($tn | tonumber)' \
        .ralph-team/team-state.json > /tmp/team-state-tmp.json && \
        mv /tmp/team-state-tmp.json .ralph-team/team-state.json 2>/dev/null || true

      # Run the agent sub-loop
      run_agent "$AGENT_SPEC_NAME" "$TICKET" "$MAX_ITERATIONS" || true
    done
  else
    echo "  ℹ️  No new assignments this iteration"
  fi

  # Log architect decisions
  DECISIONS=$(echo "$ACTION_PLAN" | jq -c '.decisions // []' 2>/dev/null || echo "[]")
  echo "$DECISIONS" | jq -c '.[]' 2>/dev/null | while read -r decision; do
    TITLE=$(echo "$decision" | jq -r '.title')
    CONTEXT=$(echo "$decision" | jq -r '.context // "N/A"')
    DECISION_TEXT=$(echo "$decision" | jq -r '.decision // "N/A"')

    echo "" >> .ralph-team/architecture-decisions.md
    echo "## $TITLE" >> .ralph-team/architecture-decisions.md
    echo "" >> .ralph-team/architecture-decisions.md
    echo "**Status**: accepted" >> .ralph-team/architecture-decisions.md
    echo "**Date**: $(date -u +%Y-%m-%d)" >> .ralph-team/architecture-decisions.md
    echo "**Context**: $CONTEXT" >> .ralph-team/architecture-decisions.md
    echo "**Decision**: $DECISION_TEXT" >> .ralph-team/architecture-decisions.md
    echo "" >> .ralph-team/architecture-decisions.md
    echo "---" >> .ralph-team/architecture-decisions.md
  done

  SUMMARY=$(echo "$ACTION_PLAN" | jq -r '.summary // "No summary"' 2>/dev/null || echo "No summary")
  echo "  📋 $SUMMARY"

  sleep 2
done

echo ""
echo "⚠️  Architect hit max iterations ($MAX_ITERATIONS)."
echo "   Review team-state.json and progress.txt for status."
exit 1
