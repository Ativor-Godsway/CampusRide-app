# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Git workflow — how finished work is handed over

**Never push directly to `main`.** A repository ruleset requires a pull request
plus three passing CI checks, so a direct push is refused anyway — but treat it
as off-limits regardless of what the remote happens to accept.

When a piece of work is finished:

1. Commit it on a **new branch**, named for the work (`fix-cors-new-render`,
   `docs-render-ci-note`).
2. Push the branch: `git push -u origin <branch>`.
3. Give the owner the **`pull/new/` link** that `git push` prints:
   `https://github.com/Ativor-Godsway/CampusRide-app/pull/new/<branch>`

The owner opens the PR and turns on auto-merge in the browser. Do not expect to
open it, merge it, or enable auto-merge from here.

### The `gh` CLI is not available

`gh` is not installed on this machine and **cannot be**. Do not try to install
it, look for it, or work around its absence — including by reading git
credentials out of the keychain to call the GitHub API directly. Push the
branch and hand over the link; that is the whole handover.

### Branch scope

Keep a branch to one piece of work. If something unrelated needs fixing along
the way (a stale comment, a doc correction), put it on its own branch so each
PR reviews as one thing.

Branches stack when the work genuinely depends on unmerged work — say so
explicitly when handing over, since the PR diff will include its ancestors
until the parent merges.
