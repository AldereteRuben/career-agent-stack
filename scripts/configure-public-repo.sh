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
# Community: Discussions for questions and ideas, discoverable topics and triage labels.
gh repo edit "$repo" --enable-discussions \
  --add-topic job-search --add-topic career --add-topic resume --add-topic local-first --add-topic self-hosted \
  --add-topic bilingual --add-topic typescript --add-topic nextjs --add-topic fastify --add-topic postgresql
gh label create "needs-triage" --repo "$repo" --color FBCA04 --description "New report waiting for a maintainer / Pendiente de revisión" --force
gh label create "translation" --repo "$repo" --color 5319E7 --description "English or Spanish text / Textos en inglés o español" --force
gh label create "good first issue" --repo "$repo" --color 7057FF --description "Small, well-described task for newcomers / Tarea pequeña para empezar" --force
gh label create "help wanted" --repo "$repo" --color 008672 --description "Contributions welcome / Se agradece ayuda" --force
# Code scanning with GitHub's CodeQL default setup (free for public repositories).
gh api --method PATCH "repos/$repo/code-scanning/default-setup" -f state=configured
gh api "repos/$repo/branches/main/protection"
gh api "repos/$repo/actions/permissions/fork-pr-contributor-approval"
gh api "repos/$repo/private-vulnerability-reporting"
gh api "repos/$repo" --jq '{visibility,has_discussions,topics,security_and_analysis}'
gh api "repos/$repo/code-scanning/default-setup" --jq '{state,languages}'
echo "Public repository controls configured. Review the returned settings."
