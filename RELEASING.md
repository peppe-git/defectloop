# Releasing

defectloop is published to npm **only** by [`.github/workflows/release.yml`](.github/workflows/release.yml),
with npm **trusted publishing**: the workflow proves its identity to npm with a short-lived OIDC token,
so no long-lived npm token is stored anywhere, and npm attaches a provenance statement that links the
published version to the commit and the workflow run that built it.

Nobody runs `npm publish` from a laptop, except in the first-release fallback described below.

## What the workflow does

On a pushed tag `v*`, or when started by hand on a tag:

1. checks that it runs on a tag, that the tag is `v` + the `version` in `package.json`, and that the
   version is a stable `MAJOR.MINOR.PATCH` (a `-SNAPSHOT` or `-rc.1` version is refused);
2. checks that npm is 11.5.1 or later (needed for trusted publishing);
3. runs `npm test` and the scrub-check;
4. runs `npm publish --provenance --access public`.

npm refuses to publish a version that already exists, so re-running a release is harmless.

## One-time setup

### npm account

- Turn on **two-factor authentication** for the npm account that will own the package
  (npmjs.com → Account → Two-Factor Authentication).
- Check that the package name is still free: `npm view defectloop` must answer 404 before the first
  release.

### GitHub repository

- The repository must be **public** when the first version is published: npm cannot generate a
  provenance statement for a private repository, and `--provenance` then fails the publish.
- Optional but recommended: create the environment `npm` (Settings → Environments) with a deployment
  rule that allows only tags matching `v*`, and required reviewers if more than one person
  maintains the project. The workflow already declares `environment: npm`.
- Protect release tags (Settings → Rules → Rulesets, target tags `v*`) so that only maintainers can
  create them.

### The first release

npm configures trusted publishers in a package's settings, so a package that has never been
published has none yet. The first version therefore needs one of these:

- **Fallback token (keeps provenance).** Create a granular access token on npmjs.com with
  **Read and write** access, **Bypass two-factor authentication** (the workflow cannot answer a 2FA
  prompt) and the shortest expiry available. Store it as the secret `NPM_TOKEN` of the `npm`
  environment (or of the repository), run the release, then **delete the secret and revoke the
  token** straight away. npm has announced that granular tokens will stop publishing directly in
  January 2027; after that, use one of the next two options.
- **Staged publishing.** `npm stage publish` (npm 11.15.0 or later) works for a package that does
  not exist yet; a maintainer then approves the staged version with 2FA on npmjs.com.
- **By hand.** From a clean checkout of the release tag, `npm publish --access public` with your
  2FA code. That first version has no provenance statement.

### The trusted publisher

Right after the first version exists, on npmjs.com → the package → **Settings** → **Trusted
Publisher** → **GitHub Actions**:

| field | value |
|---|---|
| Organization or user | the GitHub owner of the repository |
| Repository | `defectloop` |
| Workflow filename | `release.yml` (the file name only) |
| Environment name | `npm` (or empty if you did not create the environment) |
| Allowed actions | tick **`npm publish`**: the workflow publishes directly. New configurations allow only `npm stage publish` by default. |

npm does not validate the configuration when you save it, and a new configuration **expires if no
publish succeeds through it within 2 days**: plan the next release (a patch is fine) accordingly.
The `repository.url` in `package.json` must match the GitHub repository exactly, which matters for
forks.

Once a release has gone through the trusted publisher:

1. delete the `NPM_TOKEN` secret if it still exists and revoke every automation token;
2. on npmjs.com → the package → **Settings** → **Publishing access**, choose **Require two-factor
   authentication and disallow tokens**. Trusted publishing keeps working: it does not use tokens.

## Every release

1. Make sure `main` is green in CI and run the scrub-check locally **with** your private patterns
   (CI only has the generic rules; see [CONTRIBUTING.md](CONTRIBUTING.md)).
2. In `CHANGELOG.md`, turn `## [Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD` and start a new empty
   `## [Unreleased]`.
3. Set the version without creating a tag, and commit:

   ```bash
   npm version X.Y.Z --no-git-tag-version
   git commit -am "chore(release): X.Y.Z"
   ```

4. Tag and push (a signed tag if you have signing set up):

   ```bash
   git tag -s vX.Y.Z -m "vX.Y.Z"
   git push origin main vX.Y.Z
   ```

5. Watch the `release` workflow. Then check the package page on npmjs.com (version, provenance
   badge) and, from a scratch directory, `npm install defectloop@X.Y.Z` and
   `npx defectloop version`.
6. Optionally move `package.json` to the next prerelease (`X.Y.(Z+1)-SNAPSHOT`), so that a stray
   tag on `main` cannot publish anything.

## When something goes wrong

- **The release check fails**: the tag and `package.json` disagree, or the version is a prerelease.
  Delete the tag (`git push origin :refs/tags/vX.Y.Z`), fix, tag again.
- **`ENEEDAUTH` / "Unable to authenticate"**: the trusted publisher's fields do not match exactly
  (owner, repository, `release.yml`, environment), the `npm publish` action is not allowed, or the
  configuration expired.
- **A bad version is out**: publish a fixed patch release and `npm deprecate defectloop@X.Y.Z "<why>"`.
  npm allows unpublishing only within narrow limits; deprecation is the normal path.
