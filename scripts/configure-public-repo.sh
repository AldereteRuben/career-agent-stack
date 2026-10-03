#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
repo="AldereteRuben/career-agent-stack"
if [[ "$(gh api "repos/$repo" --jq .private)" != "false" ]]; then
  echo "Repository is still private. This script does not change visibility." >&2
  exit 1
fi
gh api --method PUT "repos/$repo/branches/main/protection" --input .github/main-protection.json
gh api --method PUT "repos/$repo/actions/permissions/fork-pr-contributor-approval" -f approval_policy=all_external_contributors
gh api --method PUT "repos/$repo/private-vulnerability-reporting"
gh api --method PATCH "repos/$repo" --input - <<'JSON'
{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}
JSON
gh api "repos/$repo/branches/main/protection"
gh api "repos/$repo/actions/permissions/fork-pr-contributor-approval"
gh api "repos/$repo/private-vulnerability-reporting"
gh api "repos/$repo" --jq '{visibility,security_and_analysis}'
echo "Public repository controls configured. Review the returned settings."
