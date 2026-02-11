#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# init.sh — Initialize a repo for the Ralph Team Loop
#
# Usage:
#   ./scripts/init.sh --repo-type backend --project-url "https://github.com/orgs/ORG/projects/1"
#   ./scripts/init.sh --repo-type frontend --project-url "https://github.com/orgs/ORG/projects/1"
# =============================================================================

REPO_TYPE="${RALPH_REPO_TYPE:-monorepo}"
PROJECT_URL="${RALPH_PROJECT_URL:-https://github.com/${GITHUB_TARGET_OWNER:-unknown}/${GITHUB_TARGET_REPO:-unknown}/projects/1}"
DESIGN_SYSTEM_PATH=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --repo-type) REPO_TYPE="$2"; shift 2 ;;
    --project-url) PROJECT_URL="$2"; shift 2 ;;
    --design-system) DESIGN_SYSTEM_PATH="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$REPO_TYPE" ]]; then
  REPO_TYPE="monorepo"
fi

if [[ -z "$PROJECT_URL" ]]; then
  PROJECT_URL="https://github.com/${GITHUB_TARGET_OWNER:-unknown}/${GITHUB_TARGET_REPO:-unknown}/projects/1"
fi

echo "🚀 Initializing Ralph Team Loop..."
echo "   Repo type: $REPO_TYPE"
echo "   Project: $PROJECT_URL"

# Create directory structure
mkdir -p .ralph-team/{agents,prompts,current-tasks}

# ----- Stack Detection -----
echo "🔍 Detecting tech stack..."

detect_stack() {
  local stack="{}"

  # Package manager
  if [[ -f "pnpm-lock.yaml" ]]; then
    stack=$(echo "$stack" | jq '. + {"package_manager": "pnpm"}')
  elif [[ -f "yarn.lock" ]]; then
    stack=$(echo "$stack" | jq '. + {"package_manager": "yarn"}')
  elif [[ -f "package-lock.json" ]]; then
    stack=$(echo "$stack" | jq '. + {"package_manager": "npm"}')
  elif [[ -f "Pipfile.lock" ]]; then
    stack=$(echo "$stack" | jq '. + {"package_manager": "pipenv"}')
  elif [[ -f "poetry.lock" ]]; then
    stack=$(echo "$stack" | jq '. + {"package_manager": "poetry"}')
  elif [[ -f "requirements.txt" ]]; then
    stack=$(echo "$stack" | jq '. + {"package_manager": "pip"}')
  elif [[ -f "go.mod" ]]; then
    stack=$(echo "$stack" | jq '. + {"package_manager": "go_modules"}')
  elif [[ -f "Cargo.toml" ]]; then
    stack=$(echo "$stack" | jq '. + {"package_manager": "cargo"}')
  fi

  # Language
  if [[ -f "tsconfig.json" ]]; then
    stack=$(echo "$stack" | jq '. + {"language": "typescript"}')
  elif [[ -f "package.json" ]]; then
    stack=$(echo "$stack" | jq '. + {"language": "javascript"}')
  elif [[ -f "setup.py" ]] || [[ -f "pyproject.toml" ]]; then
    stack=$(echo "$stack" | jq '. + {"language": "python"}')
  elif [[ -f "go.mod" ]]; then
    stack=$(echo "$stack" | jq '. + {"language": "go"}')
  elif [[ -f "Cargo.toml" ]]; then
    stack=$(echo "$stack" | jq '. + {"language": "rust"}')
  fi

  # Framework detection (Node.js ecosystem)
  if [[ -f "package.json" ]]; then
    local deps
    deps=$(cat package.json | jq -r '.dependencies // {} | keys[]' 2>/dev/null || echo "")
    local devdeps
    devdeps=$(cat package.json | jq -r '.devDependencies // {} | keys[]' 2>/dev/null || echo "")
    local alldeps="$deps $devdeps"

    # Frontend frameworks
    if echo "$alldeps" | grep -q "next"; then
      stack=$(echo "$stack" | jq '. + {"framework": "nextjs"}')
    elif echo "$alldeps" | grep -q "nuxt"; then
      stack=$(echo "$stack" | jq '. + {"framework": "nuxt"}')
    elif echo "$alldeps" | grep -q "svelte"; then
      stack=$(echo "$stack" | jq '. + {"framework": "sveltekit"}')
    elif echo "$alldeps" | grep -q "react"; then
      stack=$(echo "$stack" | jq '. + {"framework": "react"}')
    elif echo "$alldeps" | grep -q "vue"; then
      stack=$(echo "$stack" | jq '. + {"framework": "vue"}')
    fi

    # Backend frameworks
    if echo "$alldeps" | grep -q "express"; then
      stack=$(echo "$stack" | jq '. + {"server_framework": "express"}')
    elif echo "$alldeps" | grep -q "fastify"; then
      stack=$(echo "$stack" | jq '. + {"server_framework": "fastify"}')
    elif echo "$alldeps" | grep -q "hono"; then
      stack=$(echo "$stack" | jq '. + {"server_framework": "hono"}')
    elif echo "$alldeps" | grep -q "nest"; then
      stack=$(echo "$stack" | jq '. + {"server_framework": "nestjs"}')
    fi

    # Styling
    if echo "$alldeps" | grep -q "tailwindcss"; then
      stack=$(echo "$stack" | jq '. + {"styling": "tailwind"}')
    elif echo "$alldeps" | grep -q "styled-components"; then
      stack=$(echo "$stack" | jq '. + {"styling": "styled-components"}')
    elif echo "$alldeps" | grep -q "@emotion"; then
      stack=$(echo "$stack" | jq '. + {"styling": "emotion"}')
    fi

    # Testing
    if echo "$alldeps" | grep -q "vitest"; then
      stack=$(echo "$stack" | jq '. + {"test_framework": "vitest"}')
    elif echo "$alldeps" | grep -q "jest"; then
      stack=$(echo "$stack" | jq '. + {"test_framework": "jest"}')
    elif echo "$alldeps" | grep -q "mocha"; then
      stack=$(echo "$stack" | jq '. + {"test_framework": "mocha"}')
    fi

    # ORM / Database
    if echo "$alldeps" | grep -q "prisma"; then
      stack=$(echo "$stack" | jq '. + {"orm": "prisma"}')
    elif echo "$alldeps" | grep -q "drizzle"; then
      stack=$(echo "$stack" | jq '. + {"orm": "drizzle"}')
    elif echo "$alldeps" | grep -q "typeorm"; then
      stack=$(echo "$stack" | jq '. + {"orm": "typeorm"}')
    elif echo "$alldeps" | grep -q "sequelize"; then
      stack=$(echo "$stack" | jq '. + {"orm": "sequelize"}')
    elif echo "$alldeps" | grep -q "mongoose"; then
      stack=$(echo "$stack" | jq '. + {"orm": "mongoose", "database": "mongodb"}')
    fi
  fi

  # Python frameworks
  if [[ -f "requirements.txt" ]] || [[ -f "pyproject.toml" ]]; then
    local pyreqs=""
    [[ -f "requirements.txt" ]] && pyreqs=$(cat requirements.txt)
    [[ -f "pyproject.toml" ]] && pyreqs="$pyreqs $(cat pyproject.toml)"

    if echo "$pyreqs" | grep -qi "django"; then
      stack=$(echo "$stack" | jq '. + {"framework": "django"}')
    elif echo "$pyreqs" | grep -qi "fastapi"; then
      stack=$(echo "$stack" | jq '. + {"framework": "fastapi"}')
    elif echo "$pyreqs" | grep -qi "flask"; then
      stack=$(echo "$stack" | jq '. + {"framework": "flask"}')
    fi

    if echo "$pyreqs" | grep -qi "pytest"; then
      stack=$(echo "$stack" | jq '. + {"test_framework": "pytest"}')
    fi

    if echo "$pyreqs" | grep -qi "sqlalchemy"; then
      stack=$(echo "$stack" | jq '. + {"orm": "sqlalchemy"}')
    fi
  fi

  # Docker
  if [[ -f "Dockerfile" ]] || [[ -f "docker-compose.yml" ]] || [[ -f "docker-compose.yaml" ]]; then
    stack=$(echo "$stack" | jq '. + {"containerized": true}')
  fi

  echo "$stack"
}

DETECTED_STACK=$(detect_stack)
echo "   Detected: $DETECTED_STACK"

# ----- Config File -----
REPO_NAME=$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")
REPO_URL=$(git remote get-url origin 2>/dev/null || echo "unknown")

cat > .ralph-team/config.json << EOF
{
  "project_url": "$PROJECT_URL",
  "repo_type": "$REPO_TYPE",
  "repo_name": "$REPO_NAME",
  "repo_url": "$REPO_URL",
  "detected_stack": $DETECTED_STACK,
  "max_iterations": {
    "planner": 10,
    "architect": 20,
    "agent": 20,
    "reviewer": 10,
    "full_cycle": 3
  },
  "labels": {
    "agent_routing": ["agent:backend", "agent:frontend", "agent:qa", "agent:design-system"],
    "priority": ["priority:high", "priority:medium", "priority:low"],
    "type": ["type:feature", "type:bug", "type:chore", "type:test"],
    "repo": ["repo:backend", "repo:frontend", "repo:shared"],
    "status": ["status:ready", "status:blocked", "status:in-progress", "status:done"]
  },
  "initialized_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# ----- State Files -----
cat > .ralph-team/team-state.json << 'EOF'
{
  "tickets": {},
  "agents": {
    "architect": { "status": "idle", "current_ticket": null, "iterations": 0 },
    "backend": { "status": "idle", "current_ticket": null, "iterations": 0 },
    "frontend": { "status": "idle", "current_ticket": null, "iterations": 0 },
    "qa": { "status": "idle", "current_ticket": null, "iterations": 0 },
    "design-enforcer": { "status": "idle", "current_ticket": null, "iterations": 0 }
  },
  "sprint": {
    "status": "not_started",
    "total_tickets": 0,
    "completed_tickets": 0,
    "blocked_tickets": 0,
    "iteration": 0
  }
}
EOF

cat > .ralph-team/progress.txt << 'EOF'
# Ralph Team Loop — Progress Log
# This file is appended to by every agent after each iteration.
# It serves as cumulative memory across fresh-context Ralph iterations.
# =====================================================================

EOF

cat > .ralph-team/architecture-decisions.md << 'EOF'
# Architecture Decision Records

This file is maintained by the Architect agent. Each decision follows the
ADR format and is referenced by other agents when making implementation choices.

---

EOF

# ----- Per-Role AGENTS.md Files -----
for role in architect backend frontend qa design-enforcer reviewer; do
  role_title="$(echo "$role" | awk -F'-' '{for (i=1; i<=NF; i++) {$i=toupper(substr($i,1,1)) substr($i,2)}} 1' OFS='-')"
  cat > ".ralph-team/agents/${role}.md" << EOF
# ${role_title} Agent — Accumulated Knowledge

This file is updated by the ${role} agent after each iteration.
Future iterations read this file to benefit from previously discovered
patterns, gotchas, and conventions.

## Discovered Patterns


## Gotchas


## Conventions


## Stack-Specific Notes

EOF
done

# ----- Design System (if frontend) -----
if [[ "$REPO_TYPE" == "frontend" ]]; then
  if [[ -n "$DESIGN_SYSTEM_PATH" ]] && [[ -f "$DESIGN_SYSTEM_PATH" ]]; then
    cp "$DESIGN_SYSTEM_PATH" .ralph-team/design-system.json
  else
    cat > .ralph-team/design-system.json << 'EOF'
{
  "_comment": "This file will be populated by the Design System Enforcer on first run by scanning the codebase. You can also manually configure it.",
  "tokens": {
    "colors": {},
    "spacing": {},
    "typography": {},
    "radii": {},
    "shadows": {}
  },
  "components": {},
  "patterns": {},
  "accessibility": {
    "min_contrast_ratio": 4.5,
    "focus_visible_required": true,
    "aria_labels_required": true,
    "keyboard_navigation_required": true
  },
  "naming": {
    "components": "PascalCase",
    "files": "PascalCase.tsx",
    "css_classes": "kebab-case",
    "tokens": "kebab-case"
  },
  "forbidden": [],
  "bootstrapped": false
}
EOF
  fi
fi

# ----- Create GitHub Labels -----
echo "🏷️  Creating GitHub labels..."
create_label() {
  gh label create "$1" --color "$2" --description "$3" 2>/dev/null || true
}

create_label "agent:backend" "0E8A16" "Assigned to Backend Engineer agent"
create_label "agent:frontend" "1D76DB" "Assigned to Frontend Engineer agent"
create_label "agent:qa" "D93F0B" "Assigned to QA agent"
create_label "agent:design-system" "C5DEF5" "Assigned to Design System Enforcer agent"
create_label "priority:high" "B60205" "High priority"
create_label "priority:medium" "FBCA04" "Medium priority"
create_label "priority:low" "0E8A16" "Low priority"
create_label "type:feature" "A2EEEF" "New feature"
create_label "type:bug" "D93F0B" "Bug fix"
create_label "type:chore" "EDEDED" "Maintenance task"
create_label "type:test" "BFD4F2" "Testing task"
create_label "repo:backend" "0E8A16" "Backend repository"
create_label "repo:frontend" "1D76DB" "Frontend repository"
create_label "repo:shared" "C5DEF5" "Shared across repos"
create_label "status:ready" "0E8A16" "Ready for agent work"
create_label "status:blocked" "D93F0B" "Blocked by dependency"
create_label "status:in-progress" "FBCA04" "Agent is working on this"
create_label "status:done" "0E8A16" "Completed"
create_label "status:needs-clarification" "EDEDED" "Needs human input"

# ----- Create current-tasks directory -----
mkdir -p .ralph-team/current-tasks
for role in architect backend frontend qa design-enforcer reviewer; do
  echo '{}' > ".ralph-team/current-tasks/${role}.json"
done

# ----- Add to .gitignore -----
if ! grep -q ".ralph-team/current-tasks" .gitignore 2>/dev/null; then
  echo "" >> .gitignore
  echo "# Ralph Team Loop — ephemeral task files" >> .gitignore
  echo ".ralph-team/current-tasks/" >> .gitignore
fi

echo ""
echo "✅ Ralph Team Loop initialized!"
if [[ -f "scripts/validate-state.ts" ]]; then
  npm run --silent ralph:validate-state || {
    echo "❌ .ralph-team/team-state.json failed schema validation"
    exit 1
  }
fi
echo ""
echo "Next steps:"
echo "  1. Review .ralph-team/config.json and adjust if needed"
if [[ "$REPO_TYPE" == "frontend" ]]; then
  echo "  2. Configure .ralph-team/design-system.json with your design tokens"
fi
echo "  3. Create a PRD.md in the repo root"
echo "  4. Run: ./scripts/run-planner.sh --prd ./PRD.md"
echo "  5. Run: ./scripts/run-team.sh"
echo "  6. Run: ./scripts/run-reviewer.sh"
echo "  Or run everything: ./scripts/run-all.sh --prd ./PRD.md"
