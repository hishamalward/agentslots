# Optional launchd sweep

AgentSlots does not install or activate a daemon. The activity heartbeat must come from the active task or user; an unconditional scheduled heartbeat would keep idle resources alive forever. If you want idle cleanup, macOS `launchd` can invoke the explicit `sweep --yes` command every five minutes so an expired lease is handled promptly (the default lease is 30 minutes). A sweep only considers leases already expired; expiry plus the next scheduled sweep determines the cleanup delay.

Copy [the example plist](launchd-sweep.plist.example) to `~/Library/LaunchAgents/`, replace the absolute path to the installed `scripts/agent-slots` command, the shared repository path, and the label suffix, then validate it with `plutil -lint`. The explicit `--repo` keeps the sweep scoped to that repository's registered worktrees. Review the lease setting and sweep behavior before loading it.

Load it for the current user with `launchctl bootstrap gui/$(id -u) <plist-path>`. Check it with `launchctl print gui/$(id -u)/<label>`. Unload it with `launchctl bootout gui/$(id -u) <plist-path>` when the policy changes or the scheduled cleanup is no longer wanted.

Sweep defaults to a dry run; this optional job explicitly supplies `--yes`. It only attempts to pause expired, unpinned leases with verified process identity, and it never deletes Git branches/worktrees or releases databases. Uncertain ownership keeps resources in place. The example is documentation only: the installer does not copy it into `~/Library/LaunchAgents`, load it, or run any `launchctl` command.
