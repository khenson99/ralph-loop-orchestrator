#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   scripts/configure-github-policies.sh --owner khenson99 --repo ralph-loop-orchestrator --branch main --checks "CI / Lint + Typecheck,CI / Tests"

OWNER=""
REPO=""
BRANCH="main"
CHECKS="CI / Lint + Typecheck,CI / Tests"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner) OWNER="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --checks) CHECKS="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$OWNER" || -z "$REPO" ]]; then
  echo "--owner and --repo are required"
  exit 1
fi

IFS=',' read -r -a CHECK_ARRAY <<< "$CHECKS"
CONTEXTS=()
for check in "${CHECK_ARRAY[@]}"; do
  check_trimmed="$(echo "$check" | xargs)"
  [[ -z "$check_trimmed" ]] && continue
  CONTEXTS+=("$check_trimmed")
done

echo "Configuring repo merge defaults..."
gh api "repos/$OWNER/$REPO" -X PATCH \
  -f allow_auto_merge=true \
  -f delete_branch_on_merge=true \
  -f allow_squash_merge=true \
  -f allow_merge_commit=false \
  -f allow_rebase_merge=false >/dev/null

echo "Configuring branch protection for $BRANCH..."
contexts_json="$(printf '%s\n' "${CONTEXTS[@]}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
branch_payload="$(jq -n \
  --argjson contexts "$contexts_json" \
  '{
    required_status_checks: {
      strict: true,
      contexts: $contexts
    },
    enforce_admins: true,
    required_pull_request_reviews: {
      required_approving_review_count: 1,
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false
    },
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
    required_conversation_resolution: true,
    lock_branch: false
  }')"

gh api "repos/$OWNER/$REPO/branches/$BRANCH/protection" -X PUT \
  -H "Accept: application/vnd.github+json" \
  --input - <<<"$branch_payload" >/dev/null

echo "Enabling required linear history..."
if ! gh api "repos/$OWNER/$REPO/branches/$BRANCH/protection/required_linear_history" -X POST >/dev/null 2>&1; then
  echo "Skipping explicit required_linear_history API (already covered by protection payload or unsupported)."
fi

echo "Attempting to create merge-queue ruleset..."
ruleset_payload="$(jq -n '{
  name: "main-merge-queue",
  target: "branch",
  enforcement: "active",
  conditions: {
    ref_name: {
      include: ["refs/heads/main"],
      exclude: []
    }
  },
  rules: [
    {
      type: "merge_queue",
      parameters: {
        check_response_timeout_minutes: 30,
        grouping_strategy: "ALLGREEN",
        max_entries_to_build: 5,
        max_entries_to_merge: 1,
        merge_method: "SQUASH",
        min_entries_to_merge: 1
      }
    }
  ]
}')"

if ! gh api "repos/$OWNER/$REPO/rulesets" -X POST \
  -H "Accept: application/vnd.github+json" \
  --input - <<<"$ruleset_payload" >/dev/null 2>&1; then
  echo "Skipping merge-queue ruleset creation (unsupported plan/permissions or API shape mismatch)."
fi

echo "GitHub policy configuration complete."
