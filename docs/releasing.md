# Releasing Silos

One version names one release everywhere: the git tag, the GitHub release,
the npm package `silosplatform` and the container image
`ghcr.io/cheapestinference/silos`.

## Versions

[Semantic Versioning](https://semver.org/spec/v2.0.0.html), `MAJOR.MINOR.PATCH`,
starting at `0.1.0`.

- **PATCH** — fixes only. Nothing an install must do; no change to data on
  disk or to the API's shape.
- **MINOR** — new features, and before 1.0 also changes that ask something
  of an install (a data migration Silos runs itself, a setting that moves).
  The release notes say what changes for an install, first.
- **MAJOR** — from 1.0 on, a change an install cannot take without acting
  (a manual migration, a removed route, a dropped engine version).
- **Pre-releases** — `X.Y.Z-rc.N`, marked as a pre-release on GitHub. They
  never move `latest`.

The version lives in the root `package.json` and nowhere else: the npm
package and the image read it from there.

## Tags and releases

- A tag is `v<version>` (`v0.1.0`), annotated, on a commit of `main` whose
  CI is green. Tags are never moved or reused; a bad release is followed by
  a new PATCH, never re-tagged.
- Every tag has one GitHub release with the same name. Its notes are the
  version's section of [CHANGELOG.md](../CHANGELOG.md) ([Keep a
  Changelog](https://keepachangelog.com/en/1.1.0/)): «Changed for installs»
  first when there is anything, then Added, Changed, Fixed, Removed,
  Security.
- Only releases made from this policy live in the repository. There are no
  hand-made tags, and no tags for anything but a release.

## What a release publishes

Publishing the GitHub release runs `.github/workflows/release.yml`:

1. It checks that the tag equals `v` + the root `package.json` version.
2. It runs the typecheck and the tests, packs the npm package
   (`scripts/pack-npm.mjs`) and publishes it with provenance: as `latest`,
   or as `next` for a pre-release.
3. It builds the root `Dockerfile` and pushes the image with the tags
   `<version>` and, for a stable release, `<major>.<minor>` and `latest`.

| What        | Where                                       | Moves with each stable release   |
| ----------- | ------------------------------------------- | -------------------------------- |
| npm package | `silosplatform@<version>`                   | `latest` dist-tag                |
| image       | `ghcr.io/cheapestinference/silos:<version>` | `:<major>.<minor>` and `:latest` |

Railway's template runs `:latest` with image auto-updates on
([deploy guide](deploy/railway-template.md)); pinning `:<major>.<minor>`
takes fixes without features.

## Cutting a release

1. On `main`, move the CHANGELOG's «Unreleased» section to
   `## [<version>] - <YYYY-MM-DD>` and set the root `package.json` version.
   One commit: `release: v<version>`.
2. Wait for CI on that commit.
3. `git tag -a v<version> -m "v<version>"` and push the tag.
4. Create the GitHub release from the tag, its notes the CHANGELOG section;
   tick «pre-release» for an `-rc`.
5. Check the workflow run, then `npx silosplatform@<version> --version` and
   `docker pull ghcr.io/cheapestinference/silos:<version>`.

The repository needs one secret, `NPM_TOKEN` (an npm automation token with
publish rights on `silosplatform`). The image is pushed with the workflow's
own `GITHUB_TOKEN`.
