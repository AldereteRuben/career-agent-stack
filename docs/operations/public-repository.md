# Preparing the public community repository

## Current state

The repository remains **private**. Community files and license terms are prepared in the current source tree. Publishing is a separate owner decision.

- Issues enabled; bug, improvement and private-channel-request forms support English and Spanish and are labeled `needs-triage` (the label exists now, so forms apply it before publication too). Blank issues are disabled; questions are directed to Discussions. The private-channel form has no detail field, so a vulnerability or conduct report can ask for a private route without disclosing anything.
- Bilingual PR template, contribution guide (branches, commit prefixes, review and squash merge), [Contributor Covenant 2.1](../../CODE_OF_CONDUCT.md) code of conduct in [English](../../CODE_OF_CONDUCT.md) and [Spanish](../../CODE_OF_CONDUCT.es.md) with reports through GitHub, [getting help](../../SUPPORT.md) and `CODEOWNERS` identify the review process.
- `.editorconfig` and `.gitattributes` keep UTF-8, two-space indentation and LF line endings for every contributor, including Windows checkouts.
- Squash merging only; merged branches are automatically deleted; auto-merge is off.
- GitHub Actions uses read-only tokens, cannot approve PRs, allows GitHub-owned actions, and requires full commit SHA pins.
- CI checks lint and types; unit, UI-logic, source and archive suites; discovery, saved searches and the v0.8/v0.9 migrations against a disposable PostgreSQL service; synthetic AI, PDF, preparation and assisted-application flows with fictional data; and production builds on Ubuntu and Windows. It does **not** verify backup restore, the clean-install smoke test or the macOS `.command` launchers. Use the isolated local suites for those changes.
- Dependabot is configured for weekly npm and monthly Actions updates. Dependency vulnerability alerts are enabled. No automatic merging is configured.

## License scope

The unmodified [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) is stored in `LICENSE`. An additional, narrow permission covers an individual's own search for paid employment. Contributions are offered under both files. The standard license expressly permits use by certain noncommercial organizations regardless of funding; this is not an exception-free prohibition on every revenue-associated activity.

Commercial forks, paid hosting and commercial reuse are not generally licensed. Renaming a derivative does not remove the original material's license obligations. This is source-available licensing: [OSI's definition](https://opensource.org/osd) requires allowing commercial use. A license cannot block cloning, independent reimplementation, statutory exceptions or reuse of third-party dependencies under their own licenses, and enforcement depends on applicable law and the facts. Obtain legal review if enforceability in a particular jurisdiction is material.

The license applies to accompanying project-authored material. Historical v0.2.0 and earlier archives were published without a license; they have not been retagged. v0.3.0 is the first tagged revision containing the community/license files. Do not imply a new tag means the runtime has been revalidated on new operating systems.

## Dependency alerts

Enabling GitHub dependency alerts on 2026-10-03 exposed high-severity `drizzle-orm` entries and a medium-severity transitive `esbuild` entry. All were fixed by dependency upgrades (2026-10-03 and 2026-10-04); no alert was open on 2026-10-05. Check the [Dependabot alert queue](https://github.com/AldereteRuben/career-agent-stack/security/dependabot) again on the publication day. CI passing is not a vulnerability assessment.

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
- Discussions, repository topics, and the `needs-triage`, `translation`, `good first issue` and `help wanted` labels.
- CodeQL code scanning with GitHub's default setup.

The configuration permits administrator bypass (`enforce_admins: false`) because there is currently one owner and an author cannot approve their own PR. External contributors cannot merge without write access. When another trusted maintainer joins, consider enabling admin enforcement to require independent review for the owner's changes too.

The script exits at the first API failure; earlier operations may have succeeded. Read the output and rerun after resolving the reported limitation. GitHub feature availability may change with plan or policy.

## Before making visibility public

1. Review the Git history and release assets for personal data, credentials and private links; `.gitignore` cannot erase history. Publishing exposes **every** branch, tag and pull request ref (`refs/pull/*`, including closed pull requests), not only `main`. A scan on 2026-10-05 covered all 95 commits reachable from the `origin` branches (`main`, `chore/public-repository-readiness`, `fix/bootstrap-postgres16-set-role`), all tags and the 11 pull request refs. It found no common token formats, private keys, `.env` files, data folders or backups; the largest file is `docs/legal/dependency-license-texts.txt` (473 KB). No release has uploaded assets, only GitHub's automatic source archives. Repeat the scan if new branches or pull requests appear before publication, and decide open pull requests (such as #10) first. Commit author names and email addresses become public with the history; contributors who prefer it can use their GitHub `noreply` address for future commits. A scan is useful but is not proof that no sensitive material exists.
2. Review the license and additional permission, contribution terms, and third-party inventory. The dependency inventory reflects installed macOS packages; do a distribution-specific review before shipping binaries, especially LGPL components.
3. Confirm CI passes for the publication revision. Inspect external PR code and workflow changes before approving their runs; never give fork jobs secrets or use a personal/self-hosted runner.
4. Make visibility public only on the owner's instruction, immediately apply the script above, and confirm its read-back results.
5. In **Settings**, complete what the script cannot set: under *Moderation options → Reported content*, allow reports to maintainers (the code of conduct relies on it); review the default Discussions categories GitHub creates (*Q&A*, *Ideas*, *Show and tell* and others) instead of adding duplicates; and upload a social preview image.
6. Label a few small, well-described issues as `good first issue` so new contributors have a place to start.
7. Publish a new tagged release containing the license files and verify that GitHub offers private vulnerability reporting.

The script is intentionally manual. No publication has been scheduled.
