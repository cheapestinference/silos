# Governance

Silos is maintained by [CheapestInference](https://github.com/cheapestinference),
who also runs it every day. This page says who may do what in this
repository, how a change gets in, and how someone takes on more.

## Roles

| Role            | Who                                                                                            | May                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Contributor** | anyone                                                                                         | open issues and discussions, open pull requests from a fork, review and comment                                                                      |
| **Triager**     | contributors the owner invites, after a few useful issues or reviews                           | label, close, reopen and deduplicate issues and pull requests; ask for a reproduction; mark `good first issue`                                       |
| **Maintainer**  | contributors the owner invites for one or more areas, after sustained good pull requests there | everything a triager may, plus approve and merge pull requests **in their areas** once CI is green                                                   |
| **Owner**       | CheapestInference                                                                              | everything: the product's direction ([docs/product.md](docs/product.md)), releases, the security model, repository settings, and who holds each role |

The areas are the ones the labels and [`.github/CODEOWNERS`](.github/CODEOWNERS)
name: server, web, plugin, engines, the silo standard, docs, deploy.

## What enforces it

Roles are not a matter of trust alone; the repository is set up so that each
one can only do what the table says:

- **`main` is protected.** Every change arrives by pull request; force pushes
  and deletion are off; the `test` and `e2e` checks must pass; one approval
  is required, and it must come from the code owner of every path touched.
- **[CODEOWNERS](.github/CODEOWNERS) maps paths to people.** A maintainer is
  the code owner of their area, so their approval counts there and nowhere
  else. Workflows, the release pipeline, the `Dockerfile`, dependencies'
  manifests, `SECURITY.md`, this file and `docs/product.md` belong to the
  owner whatever the area.
- **Release tags (`v*`) cannot be moved or deleted**, and only the owner
  publishes a release ([docs/releasing.md](docs/releasing.md)). Publishing
  credentials live in repository secrets no pull request from a fork can read.
- **Pull requests from forks run CI without secrets** and with a read-only
  token.
- The owner can bypass the pull-request rule (it is how a release commit
  lands); nobody else can.

## How decisions are made

- **Bugs and fixes:** whoever reviews decides, by the rules in
  [CONTRIBUTING.md](CONTRIBUTING.md).
- **Features and UX:** the bar is the product's north star — a change must
  name the moment it serves and where the user reaches it from. Open an issue
  before the pull request; a maintainer of the area or the owner says yes, no,
  or «this is a silo, not core».
- **The silo standard and anything an install must migrate:** the owner
  decides, in the open, on the issue.
- Disagreement is settled on the issue, with reasons. The owner has the last
  word.

## Taking on more

There is no application form. Do the work of the role for a while — triage
issues, review pull requests, land changes in one area — and the owner offers
it; you can also ask in a discussion. A role that goes unused for six months
is handed back quietly, and returns the same way.

## Conduct and security

Everyone, in every role, follows the [Code of Conduct](CODE_OF_CONDUCT.md).
Vulnerabilities are reported privately, as [SECURITY.md](SECURITY.md) explains.
