# skill-census

A Claude Code plugin that counts how often each of your skills is used, so you can find the ones you never touch and remove them.

- **History.** On first run it reads your past transcripts (`~/.claude/projects`) and counts every skill the agent called and every `/skill` you typed.
- **Live count.** From then on it counts each skill as it runs: called by the agent, typed as `/name`, or preloaded into a subagent.
- **A pane.** `/skill-census` opens a pane beside the chat (desktop app and fullscreen terminal) with two tables:
  - **Skills**: uses and last use per skill, never-used ones first;
  - **Plugins**: how many of each plugin's skills you used. Plugin skills cannot be removed one by one, so this is the view for deciding which plugin to disable.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install skill-census --marketplace rustamix/skill-census
```

From a shell:

```bash
claude plugin install skill-census --marketplace rustamix/skill-census
```

In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `rustamix/skill-census` → **Add plugin**.

## Use

Run `/skill-census`. The command prints a per-plugin summary and opens the **Skill census** pane.

## How it counts

| Where | What is counted |
| --- | --- |
| Past transcripts | `Skill` tool calls and typed `/commands` (built-in ones like `/compact` are left out) |
| Live | the `skill.prompt` event, which fires for every way a skill runs |

Counts live in the plugin's own store under your Claude Code config directory and survive restarts. History is read once; uses after the plugin was first loaded are counted live, so nothing is counted twice.

## Limits

- Reading history needs `sh`, `grep` and `awk`, so it works on macOS and Linux. On Windows the live count still works.
- History only goes back as far as your transcripts do. Claude Code deletes old transcripts after `cleanupPeriodDays` (30 days by default).
- A skill that a hook injects into the context, without running it as a skill, is not counted and will look unused.
- A skill marked `user-invocable: false` shows up only once it has been used, since the list of installed skills comes from the slash-command menu.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

Run a working copy in a session with `claude --plugin-dir /path/to/skill-census`.

## License

MIT
