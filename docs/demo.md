# Web-only walkthrough

The README demo shows two existing linked worktrees: a frontend task and a docs task. Git created both before AgentSlots ran. Only the frontend requested resources.

```sh
agent-slots status --repo /demo/project
agent-slots attach --worktree /demo/frontend --service web
agent-slots start web --worktree /demo/frontend
agent-slots pause --worktree /demo/frontend
agent-slots release --worktree /demo/frontend
```

The recording used a disposable repository with a project `agent_start_web` hook running Python’s HTTP server on loopback. A real HTTP request succeeded. Pause stopped the recorded process; release removed the runtime claim while both worktrees and task branches remained. No database, queue or simulator was allocated. The docs task never attached a runtime.

Recorded on macOS from runtime revision `c7c6d8f83cad7a1864993abf81f6133f85d40c7a`. Output is abridged, temporary paths are shortened to `/demo`, and port 59168 was allocated for this run; ports depend on project configuration and availability. The cards visualize the recorded state; they are not a dashboard shipped by the CLI.

The demo uses explicit pause. Idle pause requires scheduling `sweep --yes`; AgentSlots does not install a scheduler. See [optional scheduling](launchd-scheduling.md).

[Static final frame](demo-poster.svg) · [Animated walkthrough](demo.gif)
