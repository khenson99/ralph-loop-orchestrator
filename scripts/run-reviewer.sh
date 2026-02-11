#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# run-reviewer.sh — Run the Reviewer agent in a Codex Ralph Loop
#
# Codex reviews open PRs created by the agent team, approves or requests changes.
#
# Usage:
#   ./scripts/run-reviewer.sh [--max-iterations 10]
# =============================================================================

MAX_ITERATIONS=10
CODEX_TIMEOUT_SECONDS="${CODEX_TIMEOUT_SECONDS:-180}"
CODEX_MODEL="${CODEX_MODEL:-gpt-5.3-codex}"
CODEX_REASONING_EFFORT="${CODEX_REASONING_EFFORT:-high}"
CODEX_COLLABORATION_MODE="${CODEX_COLLABORATION_MODE:-plan}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="$SCRIPT_DIR/../agents"

count_in_progress_tickets() {
  jq '[.tickets[]? | select(.status == "in_progress" or .status == "in-progress")] | length' \
    .ralph-team/team-state.json 2>/dev/null || echo "0"
}

count_unreviewed_pr_open_tickets() {
  jq '[.tickets | to_entries[]? | select((.value.status == "pr_open" or .value.status == "pr-open") and (.value.reviewed != true))] | length' \
    .ralph-team/team-state.json 2>/dev/null || echo "0"
}

list_unreviewed_pr_open_tickets() {
  jq -r '.tickets | to_entries[]? | select((.value.status == "pr_open" or .value.status == "pr-open") and (.value.reviewed != true)) | "#\(.key) (pr=\(.value.pr_number // "unknown"))"' \
    .ralph-team/team-state.json 2>/dev/null || true
}

update_ticket_review_state() {
  local ticket_number="$1"
  local status="$2"
  local reviewed="$3"
  local decision="$4"
  local pr_number="$5"
  local reviewed_at
  reviewed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  [[ -n "$ticket_number" ]] || return 0
  [[ -f ".ralph-team/team-state.json" ]] || return 0

  jq --arg tn "$ticket_number" \
     --arg status "$status" \
     --arg decision "$decision" \
     --arg reviewed_at "$reviewed_at" \
     --argjson reviewed "$reviewed" \
     --argjson pr "$pr_number" \
     '.tickets[$tn].status = $status
      | .tickets[$tn].reviewed = $reviewed
      | .tickets[$tn].review_decision = $decision
      | .tickets[$tn].reviewed_at = $reviewed_at
      | .tickets[$tn].pr_number = $pr' \
    .ralph-team/team-state.json > /tmp/team-state-tmp.json && \
    mv /tmp/team-state-tmp.json .ralph-team/team-state.json
}

resolve_ticket_number_for_pr() {
  local pr_number="$1"
  local ticket_number_from_body="$2"
  local resolved=""

  if [[ -n "$ticket_number_from_body" ]]; then
    echo "$ticket_number_from_body"
    return 0
  fi

  resolved=$(jq -r --argjson pr "$pr_number" '.tickets | to_entries[]? | select(.value.pr_number == $pr) | .key' \
    .ralph-team/team-state.json 2>/dev/null | head -1 || true)
  echo "$resolved"
}

run_codex_prompt() {
  local prompt="$1"
  local out_file cli_log
  out_file="$(mktemp "${TMPDIR:-/tmp}/ralph-reviewer-output.XXXXXX")"
  cli_log="$(mktemp "${TMPDIR:-/tmp}/ralph-reviewer-cli.XXXXXX")"

  terminate_process_tree() {
    local root_pid="$1"
    local child_pid
    while IFS= read -r child_pid; do
      [[ -n "$child_pid" ]] || continue
      terminate_process_tree "$child_pid"
    done < <(pgrep -P "$root_pid" 2>/dev/null || true)
    kill "$root_pid" 2>/dev/null || true
  }

  (
    printf '%s' "$prompt" | codex exec --dangerously-bypass-approvals-and-sandbox \
      --model "$CODEX_MODEL" \
      -c "model_reasoning_effort=\"$CODEX_REASONING_EFFORT\"" \
      -c "collaboration_mode=\"$CODEX_COLLABORATION_MODE\"" \
      --output-last-message "$out_file" \
      - >"$cli_log" 2>&1
  ) &
  local cmd_pid="$!"
  local elapsed=0

  while kill -0 "$cmd_pid" 2>/dev/null; do
    if [[ "$elapsed" -ge "$CODEX_TIMEOUT_SECONDS" ]]; then
      terminate_process_tree "$cmd_pid"
      sleep 1
      while IFS= read -r leaked_pid; do
        kill -9 "$leaked_pid" 2>/dev/null || true
      done < <(pgrep -P "$cmd_pid" 2>/dev/null || true)
      kill -9 "$cmd_pid" 2>/dev/null || true
      echo "Timed out waiting for codex review output after ${CODEX_TIMEOUT_SECONDS}s." >>"$cli_log"
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  wait "$cmd_pid" 2>/dev/null || true

  if [[ -s "$out_file" ]]; then
    cat "$out_file"
  else
    cat "$cli_log"
  fi

  rm -f "$out_file" "$cli_log"
}

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

echo "🔍 Starting Reviewer Loop (Codex)"
echo "   Max iterations: $MAX_ITERATIONS"
echo "   Codex model: $CODEX_MODEL (reasoning: $CODEX_REASONING_EFFORT, mode: $CODEX_COLLABORATION_MODE)"

ITERATION=0

while [[ $ITERATION -lt $MAX_ITERATIONS ]]; do
  ITERATION=$((ITERATION + 1))
  echo ""
  echo "━━━ Reviewer Iteration $ITERATION / $MAX_ITERATIONS ━━━"

  # Gather open PRs
  OPEN_PRS=$(gh pr list --state open --json number,title,headRefName,author,labels,body,additions,deletions,changedFiles --limit 50 2>/dev/null || echo "[]")
  PR_COUNT=$(echo "$OPEN_PRS" | jq 'length')

  if [[ "$PR_COUNT" == "0" ]]; then
    echo "   No open PRs to review."

    # Check if there are any in-progress tickets that might still produce PRs
    IN_PROGRESS=$(count_in_progress_tickets)

    if [[ "$IN_PROGRESS" == "0" ]]; then
      PENDING_REVIEW=$(count_unreviewed_pr_open_tickets)
      if [[ "$PENDING_REVIEW" != "0" ]]; then
        echo ""
        echo "❌ Guardrail failure: $PENDING_REVIEW ticket(s) are marked pr-open but were never reviewed."
        list_unreviewed_pr_open_tickets | sed 's/^/   - /'
        echo "   This usually means a PR was merged/closed outside the Reviewer loop."
        exit 1
      fi

      echo ""
      echo "✅ No open PRs and no in-progress tickets. Review complete!"

      echo "--- Reviewer Complete ---" >> .ralph-team/progress.txt
      echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .ralph-team/progress.txt
      echo "Iterations used: $ITERATION" >> .ralph-team/progress.txt
      echo "" >> .ralph-team/progress.txt

      exit 0
    fi

    echo "   ($IN_PROGRESS tickets still in progress — waiting for PRs...)"
    sleep 10
    continue
  fi

  echo "   Found $PR_COUNT open PR(s) to review"

  # Review each PR
  for PR_NUM in $(echo "$OPEN_PRS" | jq -r '.[].number'); do
    PR_TITLE=$(echo "$OPEN_PRS" | jq -r ".[] | select(.number == $PR_NUM) | .title")
    echo ""
    echo "   📝 Reviewing PR #$PR_NUM: $PR_TITLE"

    # Get the PR diff
    PR_DIFF=$(gh pr diff "$PR_NUM" 2>/dev/null || echo "Unable to fetch diff")

    # Get PR review comments (existing)
    PR_COMMENTS=$(gh pr view "$PR_NUM" --json reviews --jq '.reviews[].body' 2>/dev/null || echo "No reviews yet")

    # Get the linked issue(s) for context
    PR_BODY=$(echo "$OPEN_PRS" | jq -r ".[] | select(.number == $PR_NUM) | .body")
    ISSUE_NUM=""
    LINKED_ISSUE=""
    if echo "$PR_BODY" | grep -Eiq '(Closes|Fixes|Resolves) #[0-9]+'; then
      ISSUE_NUM=$(echo "$PR_BODY" | sed -nE 's/.*(Closes|Fixes|Resolves) #([0-9]+).*/\2/p' | head -1)
      LINKED_ISSUE=$(gh issue view "$ISSUE_NUM" --json title,body,labels --jq '{title, body, labels: [.labels[].name]}' 2>/dev/null || echo "")
    fi

    # Build the reviewer prompt
    PROMPT=$(cat <<PROMPT_EOF
You are the Reviewer agent for a Ralph Team Loop. Your job is to review PRs
for correctness, quality, testing, and security.

## Context
- Repo type: $REPO_TYPE
- Detected stack: $DETECTED_STACK
- Iteration: $ITERATION of $MAX_ITERATIONS

## PR #$PR_NUM: $PR_TITLE

### PR Body
$PR_BODY

### Linked Issue
$LINKED_ISSUE

### Previous Reviews
$PR_COMMENTS

### Diff
$PR_DIFF

## Agent Specification
$(cat "$AGENTS_DIR/reviewer.md")

## Current Progress & Learnings
$(cat .ralph-team/progress.txt 2>/dev/null || echo "No progress log yet")

## Instructions
Review this PR according to your agent specification. You must:

1. Check code correctness — does the implementation match the ticket requirements?
2. Check code quality — clean code, proper naming, no duplication, follows stack conventions
3. Check testing — are there adequate tests? Do they cover edge cases?
4. Check security — no secrets, no injection vulnerabilities, no unsafe operations
5. Check design system compliance (frontend PRs) — proper token usage, accessible markup
6. Check for regressions — does this break existing functionality?

After your review, take ONE of these actions:

**If the PR is APPROVED:**
- Run: gh pr review $PR_NUM --approve --body "Your approval message"
- Run: gh pr merge $PR_NUM --squash --delete-branch
- Output: <promise>PR_${PR_NUM}_APPROVED</promise>

**If the PR needs CHANGES:**
- Run: gh pr review $PR_NUM --request-changes --body "Detailed feedback with specific line references"
- If request-changes is rejected because you are the PR author, run: gh pr review $PR_NUM --comment --body "Detailed blocking feedback with specific line references"
- Output: <promise>PR_${PR_NUM}_CHANGES_REQUESTED</promise>

**If the PR should be CLOSED (fundamentally wrong approach):**
- Run: gh pr close $PR_NUM --comment "Reason for closing"
- Output: <promise>PR_${PR_NUM}_CLOSED</promise>

Be thorough but constructive. Reference specific lines. Suggest fixes, do not just point out problems.
PROMPT_EOF
    )

    # Run Codex for review
    OUTPUT=$(run_codex_prompt "$PROMPT")
    echo "$OUTPUT"

    # Log the review action
    if echo "$OUTPUT" | grep -Eq "^<promise>PR_${PR_NUM}_APPROVED</promise>$"; then
      echo "   ✅ PR #$PR_NUM approved and merged"
      echo "PR #$PR_NUM ($PR_TITLE): APPROVED at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .ralph-team/progress.txt
      TICKET_NUM=$(resolve_ticket_number_for_pr "$PR_NUM" "$ISSUE_NUM")
      update_ticket_review_state "$TICKET_NUM" "done" "true" "approved" "$PR_NUM"
    elif echo "$OUTPUT" | grep -Eq "^<promise>PR_${PR_NUM}_CHANGES_REQUESTED</promise>$"; then
      echo "   🔄 PR #$PR_NUM: changes requested"
      echo "PR #$PR_NUM ($PR_TITLE): CHANGES REQUESTED at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .ralph-team/progress.txt
      TICKET_NUM=$(resolve_ticket_number_for_pr "$PR_NUM" "$ISSUE_NUM")
      update_ticket_review_state "$TICKET_NUM" "changes-requested" "true" "changes_requested" "$PR_NUM"
    elif echo "$OUTPUT" | grep -Eq "^<promise>PR_${PR_NUM}_CLOSED</promise>$"; then
      echo "   ❌ PR #$PR_NUM closed"
      echo "PR #$PR_NUM ($PR_TITLE): CLOSED at $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .ralph-team/progress.txt
      TICKET_NUM=$(resolve_ticket_number_for_pr "$PR_NUM" "$ISSUE_NUM")
      update_ticket_review_state "$TICKET_NUM" "blocked" "true" "closed" "$PR_NUM"
    fi

    sleep 2
  done

  # Check if all PRs have been handled (re-check)
  REMAINING_PRS=$(gh pr list --state open --json number --jq 'length' 2>/dev/null || echo "0")
  if [[ "$REMAINING_PRS" == "0" ]]; then
    IN_PROGRESS=$(count_in_progress_tickets)
    if [[ "$IN_PROGRESS" == "0" ]]; then
      PENDING_REVIEW=$(count_unreviewed_pr_open_tickets)
      if [[ "$PENDING_REVIEW" != "0" ]]; then
        echo ""
        echo "❌ Guardrail failure: $PENDING_REVIEW ticket(s) are marked pr-open but were never reviewed."
        list_unreviewed_pr_open_tickets | sed 's/^/   - /'
        echo "   This usually means a PR was merged/closed outside the Reviewer loop."
        exit 1
      fi

      echo ""
      echo "✅ All PRs reviewed and no in-progress tickets. Review complete!"
      echo "--- All Reviews Complete ---" >> .ralph-team/progress.txt
      echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> .ralph-team/progress.txt
      echo "" >> .ralph-team/progress.txt
      exit 0
    fi
  fi

  echo ""
  echo "   Reviewer loop continuing... ($REMAINING_PRS PRs remaining, checking again)"
  sleep 5
done

echo ""
echo "⚠️  Reviewer hit max iterations ($MAX_ITERATIONS)."
echo "   There may still be open PRs to review."
exit 1
