# Releasing Draw.AI

Everything runs on your machine; there is no CI.

## One-time setup

### 1. Create a Marketplace publisher (your "publisher ID")

A publisher is the account extensions are published under. Its ID becomes part of the extension ID, for example `michaelcurtis.draw-ai`.

1. Open <https://marketplace.visualstudio.com/manage> and sign in with a Microsoft account (an Outlook/Hotmail/Live address, or a work/school account).
2. Click **Create publisher**.
3. Fill in:
    - **Name**: shown on the Marketplace page, e.g. `Michael Curtis`.
    - **ID**: lowercase letters, digits and dashes, e.g. `michaelcurtis`. **It cannot be changed later.**
4. Save. The ID is shown on the publisher page and in its URL (`…/manage/publishers/<id>`).
5. Put it in `package.json`: `node scripts/set-publisher.js <id>`

### 2. Optional: Open VSX

[Open VSX](https://open-vsx.org) is the extension store used by Cursor, Windsurf, VSCodium, Gitpod and other VS Code-based editors that cannot use Microsoft's Marketplace. Skip it if you only care about VS Code.

1. Sign in at <https://open-vsx.org> with GitHub and accept the publisher agreement (profile → **Log in with Eclipse** and sign it).
2. Profile → **Access Tokens** → **Generate New Token**. This token is your `OVSX_PAT`; keep it private.
3. Create the namespace once (use the same ID as your Marketplace publisher): `npx ovsx create-namespace <id> -p <token>`

## Each release

1. Bump `version` in `package.json` and add a `## [x.y.z]` section to `CHANGELOG.md`.
2. Run `npm run release` (or `node scripts/release.js --quick` to skip the tests that open a VS Code window). It checks the metadata, builds, runs all tests and creates `dist/draw-ai-<version>.vsix`.
3. Publish:
    - **VS Code Marketplace**: on <https://marketplace.visualstudio.com/manage>, choose **New extension → Visual Studio Code** the first time, or **… → Update** on the extension later, and upload the `.vsix`. Microsoft runs a short verification scan; the listing appears within minutes.
    - **Open VSX** (optional): `OVSX_PAT=<token> node scripts/release.js --quick --publish-openvsx`
4. Tag it: `git tag -a draw-ai-v<x.y.z> -m "Draw.AI <x.y.z>" && git push origin draw-ai-v<x.y.z>`

    Release tags carry the `draw-ai-v` prefix (the first one is `draw-ai-v0.2.0`). The repository keeps hediet/vscode-drawio's history, and clones that fetch the `upstream` remote have its tags `v0.1.3` to `v1.17.0`, the same version numbers Draw.AI goes through. A plain `v<x.y.z>` tag would clash with them.

Add `--pre-release` to `scripts/release.js` to ship a pre-release version.

### Publishing from the command line instead of uploading (optional)

Azure DevOps personal access tokens that work across organizations, which `vsce publish` traditionally used, are retired on December 1, 2026. To publish from the terminal, sign in with the Azure CLI (`az login`, using the Microsoft account that owns the publisher) and run `node scripts/release.js --publish-marketplace`, which uses `vsce publish --azure-credential`.

## Keeping draw.io up to date

`npm run update-drawio` moves the bundled draw.io to its newest release (or `node scripts/update-drawio.js v32.5.5` for a specific one). Run `node scripts/release.js --quick` and commit the `drawio` submodule change.
