# Release checklist

The original pre-release gaps are closed in the current tree:

- Project names, database names, ports, slot count, main branch, worktree prefix, app paths, env
  keys, and queue schemas are configurable.
- Next.js, Expo, Prisma, npm-workspaces, and OAuth behavior live in optional project hooks rather
  than executable core logic.
- The Vitest suite runs from this repository through `npm test` and resolves local paths.
- CI runs Bash syntax validation, TypeScript checking, and all tests on macOS.
- The pg-boss application integration is shipped as importable code and has a live positive-control
  probe.
- Required external commands are checked before their absence can be mistaken for a free resource.
- The simulator's booted-device branch has headless tests for live and dead owners.
- Worktree rollback is armed before `git worktree add` and tested in a temporary repository.
- Setup and troubleshooting documents referenced by script output exist.

## Maintainer release steps

Run from a clean checkout:

```bash
npm ci
npm run check
git diff --check
git fsck --full
```

For a release that advertises pg-boss isolation, also run `npm run test:queue` against a disposable
PostgreSQL database using two different schemas and one shared database URL.

Repository-host operations are intentionally not encoded in source: configure the intended Git
remote, confirm the public commit email, push, and create the version tag in the hosting service.
