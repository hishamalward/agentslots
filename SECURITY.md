# Security policy

`agent-slots` is local-development tooling that creates and deletes Git worktrees and PostgreSQL
databases. Treat `.agent-slots.conf` as trusted code: it is sourced by Bash and should be reviewed
like any executable script. Do not put credentials in it.

Report vulnerabilities privately through the repository host's security-advisory feature. Include
the affected script, macOS and Bash versions, the smallest reproduction available, and whether the
issue can delete data, execute an unintended command, or cross a configured slot boundary.

Only the latest tagged release is supported once releases begin. Until then, reports should target
the current default branch.
