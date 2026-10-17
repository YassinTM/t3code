# YassinTM/t3code fork

Upstream T3 Code plus my own changes, with its own nightly releases so the
desktop app's update button follows this fork.

## Branches

- `main` mirrors `pingdotgg/t3code` `main`. Never commit to it.
- `custom` is the default branch: upstream plus fork changes. Open PRs against
  `custom`.

## How releases happen

`.github/workflows/fork-release.yml`:

1. Every 30 minutes it checks for a new upstream nightly. If `custom` doesn't
   contain it yet, it merges that nightly's commit into `custom` and pushes.
   A conflict opens an "Upstream merge conflict" issue and nothing ships until
   it's resolved.
2. Every push to `custom` (an upstream merge or a merged PR) builds the Linux
   x64 and arm64 desktop apps and CLI archives and publishes a prerelease here.
3. Versions look like `0.1.1-nightly.20261016.321801`: upstream nightly run
   `3218`, fork build `01`. They sort above the upstream nightly they're based
   on and below the next one. The newest 10 releases are kept.

Run the workflow by hand with **build** checked to publish without an
upstream change.

## Fork-only changes to upstream files

Keep this list short; each one can conflict with upstream.

- `packages/shared/src/cliRelease.ts`: `CLI_RELEASE_REPOSITORY` points at this
  fork, so `t3 update` and SSH environments install fork runtimes (tests in
  `cliRelease.test.ts` and `packages/ssh/src/tunnel.test.ts` updated to match).
- `apps/web/src/state/npmRelease.ts`: "Update everything" checks that the
  version is released on this fork instead of on npm, which never has fork
  versions.

Put new features in new files where possible and hook them in with small edits.

## Fork features

- **Dictation** (voice/dictation): upstream PR pingdotgg/t3code#19273, restructured so
  its code lives in `*/dictation/*`, `contracts/src/dictation*.ts` and
  `shared/src/spokenSkills.ts`, with one- or two-line hooks in `rpc.ts`, `ws.ts`,
  `server.ts`, `settings.ts`, `RpcAuthorization.ts`, `RpcInstrumentation.ts`,
  `clientRpcPermissions.ts` and a single block in `ChatComposer.tsx`. If upstream
  merges dictation, drop the fork copy in favour of theirs.

## Setup (once)

- Repository secret `FORK_SYNC_TOKEN`: a fine-grained PAT for this repo only,
  with **Contents: read and write** and **Workflows: read and write**.
  `GITHUB_TOKEN` can't push merges that touch `.github/workflows`, and its
  pushes don't start other workflow runs.
- Repository variables `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`,
  `CLERK_CLI_OAUTH_CLIENT_ID`, and `RELAY_URL` turn on T3 Connect. They hold
  the public values every upstream build ships with (relay.t3.codes). Delete
  them to build without T3 Connect.
- All upstream workflows are disabled on this fork (the sync job re-disables
  any new ones), since they need upstream's runners and secrets.
