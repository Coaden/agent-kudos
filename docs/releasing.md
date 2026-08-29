---
layout: default
title: Releasing
---

# Releasing

Publishing is intentionally separate from ordinary CI and requires maintainer authorization.

## One-time setup

1. Confirm access to the published [`agent-kudos` npm package](https://www.npmjs.com/package/agent-kudos) under the `coaden` account.
2. Keep two-factor authentication enabled. The `0.1.0` bootstrap release was approved interactively; do not add a long-lived token to GitHub.
3. On npmjs.com, configure a trusted publisher for:
   - GitHub owner: `Coaden`
   - Repository: `agent-kudos`
   - Workflow filename: `release.yml`
   - Environment: `npm` if environment protection is enabled
   - Allowed action: `npm publish`
4. In GitHub, create an `npm` environment and preferably require maintainer approval.
5. Enable GitHub Pages with **GitHub Actions** as the source.

The release workflow uses OIDC trusted publishing, requires no long-lived npm token, and receives only `contents: read` and `id-token: write` permissions. npm trusted publishing generates provenance automatically for this public repository/package combination.

## Release checklist

1. Update `CHANGELOG.md` and remove the `Unreleased` placeholder for the version.
2. Set the version with `npm version <major|minor|patch>` and review the generated commit/tag.
3. Run:

   ```bash
   npm ci
   npm run format:check
   npm run lint
   npm run typecheck
   npm test
   npm run test:coverage
   npm run pack:check
   npm pack --dry-run
   ```

4. Push the version commit and tag.
5. Create an intentional GitHub Release for the tag.
6. Review the `Release npm package` workflow and protected environment approval.
7. Verify the npm page, provenance, tarball contents, both binaries, package exports, repository URL, and release notes.

Do not publish from a developer laptop as the normal path, do not add an `NPM_TOKEN` fallback casually, and do not reuse the Pages workflow for npm publication.
