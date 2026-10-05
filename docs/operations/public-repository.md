# Public community repository

## Current state

The repository has been **public** since 2026-10-05, on the owner's instruction. The controls below were applied with `scripts/configure-public-repo.sh` immediately afterwards and read back.

- Issues enabled; bug, improvement and private-channel-request forms support English and Spanish and are labeled `needs-triage`. Blank issues are disabled; questions are directed to Discussions. The private-channel form has no detail field, so a vulnerability or conduct report can ask for a private route without disclosing anything.
- Bilingual PR template, contribution guide (branches, commit prefixes, review and squash merge), [Contributor Covenant 2.1](../../CODE_OF_CONDUCT.md) code of conduct in [English](../../CODE_OF_CONDUCT.md) and [Spanish](../../CODE_OF_CONDUCT.es.md) with reports through GitHub, [getting help](../../SUPPORT.md) and `CODEOWNERS` identify the review process.
- `.editorconfig` and `.gitattributes` keep UTF-8, two-space indentation and LF line endings for every contributor, including Windows checkouts.
- Squash merging only; merged branches are automatically deleted; auto-merge is off.
- GitHub Actions uses read-only tokens, cannot approve PRs, allows GitHub-owned actions, and requires full commit SHA pins.
- CI checks lint and types; unit, UI-logic, source and archive suites; discovery, saved searches and the v0.8/v0.9 migrations against a disposable PostgreSQL service; synthetic AI, PDF, preparation and assisted-application flows with fictional data; and production builds on Ubuntu and Windows. It does **not** verify backup restore, the clean-install smoke test or the macOS `.command` launchers. Use the isolated local suites for those changes.
- Dependabot is configured for weekly npm and monthly Actions updates. Dependency vulnerability alerts and Dependabot security updates (pull requests that fix vulnerable dependencies) are enabled. No automatic merging is configured; each pull request goes through CI and review.
- Generated release notes are grouped by pull request label (`.github/release.yml`). Contributors' pull requests do not change versions; the maintainer releases through a release pull request (see [Contributing](../../CONTRIBUTING.md#versions-and-releases)).

## License scope

The unmodified [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) is stored in `LICENSE`. An additional, narrow permission covers an individual's own search for paid employment. Contributions are offered under both files. The standard license expressly permits use by certain noncommercial organizations regardless of funding; this is not an exception-free prohibition on every revenue-associated activity.

Commercial forks, paid hosting and commercial reuse are not generally licensed. Renaming a derivative does not remove the original material's license obligations. This is source-available licensing: [OSI's definition](https://opensource.org/osd) requires allowing commercial use. A license cannot block cloning, independent reimplementation, statutory exceptions or reuse of third-party dependencies under their own licenses, and enforcement depends on applicable law and the facts. Obtain legal review if enforceability in a particular jurisdiction is material.

The license applies to accompanying project-authored material. Historical v0.2.0 and earlier archives were published without a license; they have not been retagged. v0.3.0 is the first tagged revision containing the community/license files. Do not imply a new tag means the runtime has been revalidated on new operating systems.

## Dependency alerts

Enabling GitHub dependency alerts on 2026-10-03 exposed high-severity `drizzle-orm` entries and a medium-severity transitive `esbuild` entry. All were fixed by dependency upgrades (2026-10-03 and 2026-10-04); no alert was open on 2026-10-05. No alert was open when the repository was made public. Keep the [Dependabot alert queue](https://github.com/AldereteRuben/career-agent-stack/security/dependabot) and [code scanning alerts](https://github.com/AldereteRuben/career-agent-stack/security/code-scanning) under review. CI passing is not a vulnerability assessment.

## Repository controls

While the repository was private, GitHub rejected branch protection on the current plan (HTTP 403), and fork contributor approval and private vulnerability reporting were unavailable. After it was made public on 2026-10-05, `scripts/configure-public-repo.sh` enabled and read back:

- `main`: passing `Quality checks`, current branch, one code-owner approval, stale approvals dismissed, resolved conversations, linear history, no force pushes or deletion.
- Approval before workflows run for **all external contributors**.
- Private vulnerability reporting.
- Secret scanning and push protection.
- Discussions (with GitHub's default categories: Announcements, General, Ideas, Polls, Q&A and Show and tell), repository topics, and the `needs-triage`, `translation`, `good first issue` and `help wanted` labels.
- CodeQL code scanning with GitHub's default setup for JavaScript and TypeScript. Its first analysis reported two alerts, dismissed as false positives after review: application-journey links are always internal paths with a validated return destination, and `htmlToText` output is plain text that React and the PDF renderer escape.
- Dependabot security updates (enabled on 2026-10-05).

The configuration permits administrator bypass (`enforce_admins: false`) because there is currently one owner and an author cannot approve their own PR. External contributors cannot merge without write access. When another trusted maintainer joins, consider enabling admin enforcement to require independent review for the owner's changes too.

To re-apply the same settings, run `bash scripts/configure-public-repo.sh` from a trusted checkout. It refuses to run while the repository is private, never changes visibility, and exits at the first API failure; earlier operations may have succeeded. GitHub feature availability may change with plan or policy.

## Publication record

Before visibility changed, a scan on 2026-10-05 covered all 95 commits reachable from the `origin` branches (`main`, `chore/public-repository-readiness`, `fix/bootstrap-postgres16-set-role`), all tags and the 11 pull request refs (`refs/pull/*`, which are public too, including closed pull requests). It found no common token formats, private keys, `.env` files, data folders or backups; the largest file is `docs/legal/dependency-license-texts.txt` (473 KB). No release had uploaded assets, only GitHub's automatic source archives. CI passed on the publication revision. A scan is useful but is not proof that no sensitive material exists. Commit author names and email addresses are public with the history; contributors who prefer it can use their GitHub `noreply` address for future commits.

## Remaining owner steps

These cannot be set through the API:

1. In **Settings → Moderation options → Reported content**, allow reports to maintainers; the code of conduct relies on it.
2. Optionally upload a social preview image in **Settings → General**.
3. Label a few small, well-described issues as `good first issue` so new contributors have a place to start.
4. Publish a new tagged release containing the license files.

## Reviewing external contributions

Inspect external pull request code and any workflow changes before approving their CI runs. Never give fork jobs secrets or use a personal or self-hosted runner. Review the license, contribution terms and third-party inventory when dependencies change; the dependency inventory reflects installed macOS packages, so do a distribution-specific review before shipping binaries, especially LGPL components.
