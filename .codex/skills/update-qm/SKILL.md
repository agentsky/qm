---
name: update-qm
description: Update a QM source fork by merging upstream and open a PR. Use when asked to "update qm", "sync from upstream", "pull in the latest qm".
---

# update-qm

Confirm this is a source fork before choosing the update procedure. Source forks may
intentionally change core; preserve those changes. Contributing them upstream is
optional.

## Identify the checkout

Run `git remote -v` and inspect the files and ancestry. If `origin` is `yc-software/qm`,
this is upstream itself, not a downstream sync target. A different origin alone does
not prove a source fork. A source fork has the QM source tree and shared upstream
history.

For a source fork, check the `upstream` remote points to `yc-software/qm`; if absent, add
`git remote add upstream git@github.com:yc-software/qm`. Confirm shared history before
merging. Never merge downstream history into upstream. Use `--repo` on every `gh`
command. Inspect the actual default branch; the examples below assume `main` and must
be adapted if the fork deliberately uses another name. If a mirror-seeded repository
has a stale feature branch as its default, identify the intended base before syncing;
do not silently merge into the stale branch or delete existing refs.

## Merge, never rebase

`origin/main` is published history that deploys and other clones track. Rebasing it onto
upstream rewrites those commits, so always merge.

```bash
git switch main
git pull --ff-only origin main
git fetch upstream
git switch -c codex/sync-upstream-<yyyy-mm-dd>
git log --oneline main..upstream/main
git merge upstream/main
```

Record the commit range before resolving anything so the PR can state it. If the merge
reports "Already up to date", delete the branch and report that instead of opening an empty
PR.

## Resolving conflicts

Read both sides and the local commits that explain the customization. Preserve
intentional local behavior while integrating upstream fixes; a core conflict is expected
maintenance, not a policy violation. Keep deployment data in the layer or separate
private deployment repository where practical. Do not discard a core modification just
because it is organization-specific or insist it be contributed upstream.

Document conflicts, resolutions, and remaining divergence in the sync PR. When intent
cannot be recovered from code, tests, or history, ask the operator before choosing a
behavior. Review inherited CI and publishing changes for the fork's own accounts and
registries rather than enabling upstream workflows blindly.

## Verify before opening the PR

Determine affected tests from the merged range and conflict resolutions. Run those
locally plus typecheck and lint.
Use the full local suite only when the affected scope cannot be determined; otherwise
let CI run it. Install the locked dependencies first:

```bash
npm ci
npm run typecheck
npm run lint
```

A sync can change the Helm chart's values. Render each organization layer against the
merged chart and review the diff:

```bash
helm template qm deploy/helm -f deploy/layers/<org>/values.yaml
```

For deployments outside the checkout, substitute their values paths. Adapting a values
file the merged chart no longer accepts is part of the sync. Verify non-trivial behavior
changes in a live dev instance before opening the PR, per AGENTS.md. Merging source does
not update the published runtime images; deploy them with `scripts/deploy-helm.sh` or the
release workflow. See the README source deployment procedure.

## Open the PR

```bash
git push -u origin codex/sync-upstream-<yyyy-mm-dd>
gh pr create --repo <source-fork> --base main \
  --title "Sync upstream qm through <short-sha>" \
  --body-file .generated/sync-body.md
```

Pass `--repo` to every `gh` command you run in a private fork. Without it, `gh` picks a base
repository from the clone's remotes and may choose `upstream`: the sync PR gets opened
against qm, and `gh pr edit 1` overwrites whatever PR is number 1 in the source repository.
The same applies to `gh pr view`, `gh pr list`, and `gh issue`.

The description should state the upstream commit range merged, any file outside
`deploy/layers/` that conflicted and how it was resolved, and the results of the checks
above.

When authorized to land a source-sync PR, preserve the upstream ancestry with a merge
commit (`gh pr merge --repo <source-fork> <pr> --merge`) or an ancestry-preserving
fast-forward. Never squash or rebase a source-sync PR, even if the repository's usual
shipping workflow uses squash: that loses the upstream merge and causes later syncs to
revisit already-integrated history. If repository settings prohibit merge commits,
resolve that policy before landing; do not fall back to squash.

If the private fork deploys from `main`, merging this PR ships upstream's changes to production,
so merge when someone can watch it.

A source fork runs its enabled CI workflows in its own account. A sync that
adds or changes CI changes what runs on the next PR, and workflows that need secrets the
fork never received will fail until those are supplied.

## Never do these

- `git push --mirror` to seed or update a source fork. It copies unrelated branches and
  tags, leaves initial default-branch selection implicit, and can delete destination-only
  refs. Seed only `main` and explicitly set the default branch as the README shows.
- Pushing a branch whose history contains organization commits to upstream. The
  `upstream-pr` skill pushes upstream only from branches cut fresh from `upstream/main`
  and scrubbed.
- Rebasing `main` onto `upstream/main`, or force-pushing a private fork's `main`.
- Resolving a conflict by deleting the upstream side wholesale to quiet the merge. That
  silently diverges core from upstream, and the divergence returns as a larger conflict in
  the next sync.
