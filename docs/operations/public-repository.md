# Preparing the public community repository

## Current state

The repository remains **private**. Community files and license terms are prepared in the current source tree. Publishing is a separate owner decision.

- Issues enabled; bug and improvement forms support English and Spanish.
- PR template, contribution terms, conduct rules and `CODEOWNERS` identify the review process.
- Squash merging only; merged branches are automatically deleted; auto-merge is off.
- GitHub Actions uses read-only tokens, cannot approve PRs, allows GitHub-owned actions, and requires full commit SHA pins.
- CI checks lint, types, existing unit/source/archive suites and production compilation. It does **not** verify browser flows, PostgreSQL restore or clean-install behavior on Linux. Use the isolated local suites for those changes.
- Dependabot is configured for weekly npm and monthly Actions updates. Dependency vulnerability alerts are enabled. No automatic merging is configured.

## License scope

The unmodified [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) is stored in `LICENSE`. An additional, narrow permission covers an individual's own search for paid employment. Contributions are offered under both files. The standard license expressly permits use by certain noncommercial organizations regardless of funding; this is not an exception-free prohibition on every revenue-associated activity.

Commercial forks, paid hosting and commercial reuse are not generally licensed. Renaming a derivative does not remove the original material's license obligations. This is source-available licensing: [OSI's definition](https://opensource.org/osd) requires allowing commercial use. A license cannot block cloning, independent reimplementation, statutory exceptions or reuse of third-party dependencies under their own licenses, and enforcement depends on applicable law and the facts. Obtain legal review if enforceability in a particular jurisdiction is material.

The license applies to accompanying project-authored material. Historical v0.2.0 and earlier archives were published without a license; they have not been retagged. v0.3.0 is the first tagged revision containing the community/license files. Do not imply a new tag means the runtime has been revalidated on new operating systems.

## Dependency alerts to resolve before publication

Enabling GitHub dependency alerts on 2026-10-03 exposed four open alerts: three high-severity entries for `drizzle-orm` (SQL identifier escaping; GitHub lists 0.45.2 as the first patched version) and one medium-severity entry for a transitive `esbuild` development-server issue (first patched version 0.25.0). Repeated Drizzle entries reflect dependency locations, not three distinct advisories.

See the private [Dependabot alert queue](https://github.com/AldereteRuben/career-agent-stack/security/dependabot). This repository-configuration change does not update runtime dependencies or determine exploitability. Resolve or document these findings with an appropriate dependency upgrade and regression verification before making a public release. CI passing is not a vulnerability assessment.

## Controls pending publication

GitHub rejected branch protection for this private repository on the current plan (HTTP 403). Fork contributor approval is public-only here (HTTP 422); private vulnerability reporting was unavailable (HTTP 404). These controls are **not active** yet. `CODEOWNERS` alone does not enforce review.

Once the owner has made the repository public, run from a trusted checkout:

```sh
bash scripts/configure-public-repo.sh
```

The script refuses to run while private and never changes visibility. It enables and reads back:

- `main`: passing `Quality checks`, current branch, one code-owner approval, stale approvals dismissed, resolved conversations, linear history, no force pushes or deletion.
- Approval before workflows run for **all external contributors**.
- Private vulnerability reporting.
- Secret scanning and push protection.

The configuration permits administrator bypass (`enforce_admins: false`) because there is currently one owner and an author cannot approve their own PR. External contributors cannot merge without write access. When another trusted maintainer joins, consider enabling admin enforcement to require independent review for the owner's changes too.

The script exits at the first API failure; earlier operations may have succeeded. Read the output and rerun after resolving the reported limitation. GitHub feature availability may change with plan or policy.

## Before making visibility public

1. Review the Git history and release assets for personal data, credentials and private links; `.gitignore` cannot erase history. A scan for known current secrets and common token formats is useful but is not proof that no sensitive material exists.
2. Review the license and additional permission, contribution terms, and third-party inventory. The dependency inventory reflects installed macOS packages; do a distribution-specific review before shipping binaries, especially LGPL components.
3. Confirm CI passes for the publication revision. Inspect external PR code and workflow changes before approving their runs; never give fork jobs secrets or use a personal/self-hosted runner.
4. Make visibility public only on the owner's instruction, immediately apply the script above, and confirm its read-back results.
5. Publish a new tagged release containing the license files and verify that GitHub offers private vulnerability reporting.

The script is intentionally manual. No publication has been scheduled.
