# telestrator

## Commits and PR titles: Conventional Commits

Every commit message **and** every PR title (squash merges use it as the commit) follows
[Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

- Types: `feat` (new feature), `fix` (bug fix), `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Scope is optional, a noun for the part of the codebase in parentheses: `fix(ui): …`, `feat(mcp): …`.
- The description comes right after `: `, lowercase, imperative, no trailing period.
- Body (optional) starts one blank line after the description; footers (optional) one blank line after the body,
  in git-trailer form: `Refs: #12`, `Reviewed-by: Z`.
- Breaking change: `!` right before the colon (`feat(mcp)!: …`) and/or a footer `BREAKING CHANGE: <what breaks>`
  (always uppercase).
- Reverts: `revert: <original description>` with a `Refs: <sha>` footer.
- One logical change per commit; if it fits two types, split it into two commits.
- Examples: `feat(cli): add --json output to doctor`, `fix(ui): keep pin inside the frame`, `docs: clarify privacy FAQ`.

Why: releases are automated by [release-please](https://github.com/googleapis/release-please).
It reads these messages to pick the next version and write `CHANGELOG.md`. `feat` bumps minor,
`fix` bumps patch (breaking changes bump minor while we're below 1.0); other types don't
trigger a release. Merging the release PR tags a GitHub release and publishes it to npm.

Enforced: the `pr-title` check fails any PR whose title isn't a Conventional Commit, and `main`
only takes squash merges titled from the PR, so nothing else reaches the changelog.

Never hand-edit `version` in `package.json`, `.release-please-manifest.json`, or `CHANGELOG.md`:
release-please owns them.
