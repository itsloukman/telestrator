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

## Shipping a change

`main` is protected: no direct pushes, squash merge only, the `conventional-commit` check must pass.

1. Branch off `main`, commit (Conventional Commits), push, `gh pr create` with a conventional title.
2. `gh pr merge <n> --squash` once the check is green.
3. Changing anything in `.github/workflows/` needs a `gh` token with the `workflow` scope; if the push
   is rejected for that, `gh auth switch -u itsloukman` (the account that has it) and push again.

## Releasing

Never run `npm publish` or create tags/releases by hand. The flow is:

1. Every `feat`/`fix` merged to `main` makes release-please open or update a PR titled
   `chore(main): release X.Y.Z`, with the version bump and the `CHANGELOG.md` entry.
2. To release: review that PR, then `gh pr merge <n> --squash --admin`. `--admin` is required:
   GitHub doesn't run checks on PRs opened by Actions, so the required check never reports.
3. Merging it tags `vX.Y.Z`, creates the GitHub release, runs `npm test` and publishes to npm
   through Trusted Publishing (OIDC, no token). npm trusts exactly `itsloukman/telestrator` +
   `.github/workflows/release-please.yml`: renaming that file breaks publishing.
4. Check it landed: `gh run list --workflow release-please --limit 1` and `npm view telestrator version`.

To force a specific version (e.g. `1.0.0`), add a `Release-As: 1.0.0` footer to a commit.
