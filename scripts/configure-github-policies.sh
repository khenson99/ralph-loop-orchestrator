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
CONTEXT_FLAGS=()
for check in "${CHECK_ARRAY[@]}"; do
  check_trimmed="$(echo "$check" | xargs)"
  [[ -z "$check_trimmed" ]] && continue
  CONTEXT_FLAGS+=("-f" "required_status_checks[contexts][]=$check_trimmed")
done

echo "Configuring repo merge defaults..."
gh api "repos/$OWNER/$REPO" -X PATCH \
  -f allow_auto_merge=true \
  -f delete_branch_on_merge=true \
  -f allow_squash_merge=true \
  -f allow_merge_commit=false \
  -f allow_rebase_merge=false >/dev/null

echo "Configuring branch protection for $BRANCH..."
gh api "repos/$OWNER/$REPO/branches/$BRANCH/protection" -X PUT \
  -H "Accept: application/vnd.github+json" \
  -f required_status_checks[strict]=true \
  "${CONTEXT_FLAGS[@]}" \
  -f enforce_admins=true \
  -f required_pull_request_reviews[required_approving_review_count]=1 \
  -f required_pull_request_reviews[dismiss_stale_reviews]=true \
  -f required_pull_request_reviews[require_code_owner_reviews]=false \
  -f restrictions= >/dev/null

echo "Enabling required linear history..."
gh api "repos/$OWNER/$REPO/branches/$BRANCH/protection/required_linear_history" -X POST >/dev/null || true

echo "Attempting to create merge-queue ruleset..."
gh api "repos/$OWNER/$REPO/rulesets" -X POST \
  -H "Accept: application/vnd.github+json" \
  -f name='main-merge-queue' \
  -f target='branch' \
  -f enforcement='active' \
  -F conditions[ref_name][include][]='refs/heads/main' \
  -F conditions[ref_name][exclude][]='' \
  -F rules[]='{"type":"merge_queue"}' >/dev/null || true

echo "GitHub policy configuration complete."
