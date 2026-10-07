# AgentSlots contributor notes

AgentSlots allocates local development resources to concurrent coding-agent workspaces. It does
not launch or coordinate agents, define their plans, or enforce project permissions.

## Before changing code

- Keep the runtime focused on worktrees, stack slots, ports, databases, queues, and exclusive
  device locks.
- Keep Bash compatible with macOS system Bash 3.2 and BSD userland. Avoid Bash 4 features and
  GNU-only utility flags.
- Treat `.agent-slots.conf` as trusted shell code. Never put credentials in it.
- Check ownership before removing worktrees, databases, processes, or locks. Unknown ownership
  means refuse and explain how to inspect it.
- Keep project-specific setup and server commands in configuration hooks, not in the shared core.
- Do not add Linux, Windows, cloud, container, daemon, dashboard, or orchestration support without
  an explicit product decision.

## Documentation

- Display name: AgentSlots. Repository and package name: `agentslots`.
  Existing `.agent-slots.conf` and `~/.agent-slots` paths stay compatible.
- Product documentation is Markdown. Keep the README concise and link to focused guides.
- New work may point to an existing project state document with `--state`; AgentSlots does not
  generate plans, handovers, or task records.
- State is derived from Git and the local system. Do not add a registry that duplicates it.
- Describe verification as historical or pending unless it was run against the current revision.
- Keep SVG identity artwork editable and use the palette in `docs/agentslots-banner-light-asset.svg`.

## Runtime requirements

The installer and workspace-ownership helpers require Python 3.10 or newer. The runtime targets
macOS system Bash 3.2 and BSD userland.

## Checks

Run the repository's relevant checks before reporting a code change:

```sh
npm run check
```

For queue changes, also run `npm run test:queue` against disposable PostgreSQL schemas. Do not
point local tooling at production or a shared backend.
