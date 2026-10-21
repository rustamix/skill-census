# skill-census

Usage statistics for Claude Code skills. `skill-census` counts how often each installed skill runs and shows which skills and plugins you never use, so you can remove them.

Every installed skill takes room in the agent's context and in the slash-command menu, whether it runs or not.

Example output of `/skill-census`:

```
skill-census: 28 of 527 skills used, 499 never.

| Plugin            | Skills used | Uses | Last used |
| ----------------- | ----------: | ---: | --------- |
| ecc               |     0 / 397 |    0 | never     |
| figma             |      0 / 16 |    0 | never     |
| docker-skills     |      0 / 11 |    0 | never     |
| superpowers       |      9 / 15 |  115 | 1d ago    |
| your skills       |     17 / 35 |  108 | today     |
```

## Install

Requires **Claude Code 2.1.286 or newer** (`claude --version`). The plugin uses Claude Code's hooks-module API, which is in early access, so an older version will not load it.

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

Run `/skill-census`. It prints a per-plugin summary and opens the **Skill census** pane beside the chat (desktop app and fullscreen terminal) with two tables:

- **Skills**: uses and last use of each skill, never-used ones first;
- **Plugins**: how many of each plugin's skills you used. A plugin's skills cannot be removed one by one, so this is the view for deciding which plugin to disable.

## How it counts

- **History.** On first run it reads your past transcripts (`~/.claude/projects`) once and counts every skill the agent called and every `/skill` you typed. Built-in commands like `/compact` are left out.
- **Live.** From then on it counts each skill as it runs, through the `skill.prompt` event: called by the agent, typed as `/name`, or preloaded into a subagent.

Counts are kept in the plugin's own store under your Claude Code config directory and survive restarts. Uses after the plugin was first loaded are counted live only, so nothing is counted twice. Nothing leaves your machine.

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

MIT. Not affiliated with Anthropic.
