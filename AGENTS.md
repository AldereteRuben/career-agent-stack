# Working on Career Stack

Keep the interface bilingual (Spanish and English), usable with keyboard and on mobile, and use operating-system-neutral instructions unless a step is platform specific.

## Commit messages

Preserve contributor authorship. Do not append co-author or generator attribution for automated tools, assistants or models to commit messages. Apply this rule to delegated workers as well.

## Completing a version

When the user authorizes a release, finish the full release sequence:

1. Run the relevant automated tests and isolated end-to-end flows. Never use the real workspace as a test fixture.
2. Align package versions, RELEASE_VERSION, CHANGELOG and installation documentation. Record limitations honestly.
3. Commit the completed work and validate CI before updating main.
4. Push main, create an annotated `vX.Y.Z` tag at the verified release commit, and push that tag.
5. Publish a GitHub release with reviewed notes and mark the newest stable version as Latest.
6. Verify the remote tag commit and published release URL; report both. A version is not finished with just a commit or push.

Keep the GitHub repository private until the user explicitly authorizes making it public. Do not include credentials, local data, generated backups or private test artifacts in commits or release assets.
