# Security policy

AgentSlots is local development tooling. It provisions and removes Git worktrees and local
PostgreSQL databases, and it may stop processes that own configured ports.

Treat `.agent-slots.conf` as trusted Bash code. Review it before use and do not put credentials in
it. The scripts are not a security boundary between hostile processes and cannot prevent a user
from configuring a local service to use a shared backend.

Report vulnerabilities privately through the repository host's security advisory feature. Include
the affected script, macOS and Bash versions, a small reproduction, and whether the issue can delete
data, execute an unintended command, or cross a configured resource boundary.

The latest tagged release is supported. For an unreleased candidate, include its branch and commit
SHA so the report can be matched to the tested code.
