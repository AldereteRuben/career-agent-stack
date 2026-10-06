# Working on Career Stack

Keep the interface bilingual (Spanish and English), usable with keyboard and on mobile, and use operating-system-neutral instructions unless a step is platform specific.

## Commit messages

Preserve contributor authorship. Do not append co-author or generator attribution for automated tools, assistants or models to commit messages. Apply this rule to delegated workers as well.

## Completing a version

When the user authorizes a release, finish the full release sequence:

1. Run the relevant automated tests and isolated end-to-end flows. Never use the real workspace as a test fixture.
2. Align package versions, RELEASE_VERSION, CHANGELOG and installation documentation. Record limitations honestly.
3. Commit the completed work on a `release/vX.Y.Z` branch and open a release pull request titled `release: vX.Y.Z`. `main` is protected: never push to it directly.
4. Wait for green CI on the release pull request, then squash-merge it with the owner's authorization (the owner may use the administrator bypass because an author cannot approve their own pull request). Create an annotated `vX.Y.Z` tag at the resulting commit on `main` and push that tag.
5. Publish a GitHub release with reviewed notes, starting from GitHub's generated notes so merged pull requests and new contributors are credited, and mark the newest stable version as Latest.
6. Verify the remote tag commit and published release URL; report both. A version is not finished with just a commit or push.

Contributors' pull requests never change versions, `RELEASE_VERSION` or the changelog; those change only in a release pull request. Label each pull request before merging so it lands in the right section of the generated release notes (`.github/release.yml`).

The GitHub repository is public. Do not include credentials, local data, generated backups or private test artifacts in commits, pull requests, issues or release assets.
