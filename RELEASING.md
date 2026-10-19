# Releasing Draw.io AI

## One-time setup

1. Create a publisher at <https://marketplace.visualstudio.com/manage> and set it: `node scripts/set-publisher.js <publisher-id>`.
2. Create an Azure DevOps personal access token with the **Marketplace (Manage)** scope and add it as the `VSCE_PAT` repository secret.
3. Optional: add an [Open VSX](https://open-vsx.org) token as `OVSX_PAT` to also publish there (needed for VSCodium, Cursor, Windsurf and others).
4. Make the repository public. The Marketplace page shows README images from GitHub, and GPL-3.0 requires the source to be available to users.

## Each release

1. Update `version` in `package.json` and add a matching `## [x.y.z]` section to `CHANGELOG.md`.
2. Run `node scripts/release-check.js --built` after a build (`yarn build-extension && yarn build-plugins`) and the tests (`yarn test:ai`, `yarn test:ai-e2e`, `yarn test:ai-vscode`).
3. Commit, then tag and push: `git tag v<x.y.z> && git push origin v<x.y.z>`.

The **Release** workflow builds, runs the tests and the release check, attaches the VSIX to a GitHub release with the changelog section as notes, and publishes to the Marketplace (and Open VSX) when the tokens are set. Run it manually with **Publish as a pre-release** to ship a pre-release instead.
