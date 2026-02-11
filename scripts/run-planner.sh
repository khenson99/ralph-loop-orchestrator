#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# run-planner.sh — Run the Planner agent in a Codex Ralph Loop
#
# Codex reads the PRD and creates GitHub issues with labels and acceptance
# criteria on the project board.
#
# Usage:
#   ./scripts/run-planner.sh --prd ./PRD.md [--max-iterations 10]
# =============================================================================

PRD_PATH=""
MAX_ITERATIONS=10
CODEX_MODEL="${CODEX_MODEL:-gpt-5.3-codex}"
CODEX_REASONING_EFFORT="${CODEX_REASONING_EFFORT:-high}"
CODEX_COLLABORATION_MODE="${CODEX_COLLABORATION_MODE:-plan}"

while [[ $# -gt 0 ]]; do
  case $1 in
    --prd) PRD_PATH="$2"; shift 2 ;;
    --max-iterations) MAX_ITERATIONS="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$PRD_PATH" ]]; then
  echo "Error: --prd is required"
  exit 1
fi

if [[ ! -f "$PRD_PATH" ]]; then
  echo "Error: PRD file not found: $PRD_PATH"
  exit 1
fi

if [[ ! -f ".ralph-team/config.json" ]]; then
  echo "Error: .ralph-team/config.json not found. Run init.sh first."
  exit 1
fi

PROJECT_URL=$(jq -r '.project_url' .ralph-team/config.json)
REPO_TYPE=$(jq -r '.repo_type' .ralph-team/config.json)
DETECTED_STACK=$(jq -c '.detected_stack' .ralph-team/config.json)

echo "📋 Starting Planner Loop (Codex)"
echo "   PRD: $PRD_PATH"
echo "   Max iterations: $MAX_ITERATIONS"
echo "   Project: $PROJECT_URL"
echo "   Codex model: $CODEX_MODEL (reasoning: $CODEX_REASONING_EFFORT, mode: $CODEX_COLLABORATION_MODE)"

ITERATION=0

while [[ $ITERATION -lt $MAX_ITERATIONS ]]; do
  ITERATION=$((ITERATION + 1))
  echo ""
  echo "━━━ Planner Iteration $ITERATION / $MAX_ITERATIONS ━━━"

  # Build the planner prompt
  PROMPT=$(cat << PROMPT_EOF
You are the Planner agent for a Ralph Team Loop. Your job is to read a PRD
and create GitHub issues on the project board.

## Context
- Repo type: $REPO_TYPE
- Detected stack: $DETECTED_STACK
- Project URL: $PROJECT_URL
- Iteration: $ITERATION of $MAX_ITERATIONS

## PRD
$(cat "$PRD_PATH")

## Existing Issues
$(gh issue list --state open --json number,title,labels --limit 100 2>/dev/null || echo "No issues yet")

## Agent Specification
$(cat "$(dirname "$0")/../agents/planner.md")

## Instructions
1. Read the PRD above
2. Check which PRD items already have GitHub issues (to avoid duplicates)
3. Create GitHub issues for any PRD items that do not have tickets yet
4. Apply appropriate labels (agent routing, priority, type, repo, status)
5. Include clear acceptance criteria in each issue
6. If ALL PRD items now have corresponding issues, output: <promise>PLANNING_COMPLETE</promise>
7. If you created issues this iteration, list them

Remember: Each issue should be atomic, testable, and completable by a single agent
in ~20 iterations.
PROMPT_EOF
  )

  # Run Codex
  OUTPUT=$(codex exec \
    --dangerously-bypass-approvals-and-sandbox \
    --model "$CODEX_MODEL" \
    -c "model_reasoning_effort=\"$CODEX_REASONING_EFFORT\"" \
    -c "collaboration_mode=\"$CODEX_COLLABORATION_MODE\"" \
    -p "$PROMPT" 2>&1) || true

  echo "$OUTPUT"

  # Check for completion promise
  if echo "$OUTPUT" | grep -q "<promise>PLANNING_COMPLETE</promise>"; then
    echo ""
    echo "✅ Planner complete! All PRD items have tickets."

    # Update progress
    echo "--- Planner Complete ---" >> .ralph-team/progress.txt
    echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .ralph-team/progress.txt
    echo "Iterations used: $ITERATION" >> .ralph-team/progress.txt
    echo "" >> .ralph-team/progress.txt

    exit 0
  fi

  echo "   Planner still working... (iteration $ITERATION)"
  sleep 2
done

echo ""
echo "⚠️  Planner hit max iterations ($MAX_ITERATIONS) without completing."
echo "   Check GitHub issues and run again if needed."
exit 1
