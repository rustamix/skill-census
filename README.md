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

From a shell:

```bash
claude plugin marketplace add rustamix/skill-census
claude plugin install skill-census@skill-census
```

Or at the prompt of a Claude Code terminal session:

```
/plugin marketplace add rustamix/skill-census
/plugin install skill-census@skill-census
```

In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `rustamix/skill-census` → **Add plugin**.

Start a new session afterwards, then run `/skill-census`.

Update with `claude plugin marketplace update skill-census` and `claude plugin update skill-census@skill-census`; remove with `claude plugin uninstall skill-census@skill-census`.

## Use

Run `/skill-census`. It prints a per-plugin summary and opens the **Skill census** pane beside the chat (desktop app and fullscreen terminal) with two tables:

- **Skills**: uses and last use of each skill, never-used ones first;
- **Plugins**: how many of each plugin's skills you used. A plugin's skills cannot be removed one by one, so this is the view for deciding which plugin to disable. Below the table, plugins with no used skill are listed biggest first, each with its `claude plugin disable <plugin>@<marketplace>` command.

## How it counts

- **History.** On first run it reads your past transcripts (`~/.claude/projects`) once and counts every skill the agent called and every `/skill` you typed. Built-in commands like `/compact` are left out.
- **Live.** From then on it counts each skill as it runs, through the `skill.prompt` event: called by the agent, typed as `/name`, or preloaded into a subagent.

Counts are kept in the plugin's own store under your Claude Code config directory and survive restarts. History and live uses are stored apart, so a second import (two sessions starting at once) replaces history instead of counting it twice.

## Data and programs

**Sends nothing.** The plugin makes no network requests and passes nothing to the model beyond the `/skill-census` output you ask for. Everything it reads stays on your machine.

**Reads:**
- your transcripts, `<config dir>/projects/**/*.jsonl` (`~/.claude/projects` by default), once, on first run;
- the list of slash commands, to know which skills are installed;
- `enabledPlugins` from your Claude Code settings, to name the `claude plugin disable` command for each plugin.

**Writes:** only its own plugin store: for each skill, how many times it ran and when it last ran.

**Runs one program,** once, on first run: `grep`, started directly (no shell), with fixed arguments and the projects folder as the last one:

```
grep -rhE --include=*.jsonl -e '"name":"Skill","input":\{"skill":"' -e '<command-name>/' <config dir>/projects
```

It keeps only the transcript lines with a Skill tool call or a typed `/command`; the plugin parses those lines itself. `grep` is used because transcripts can be tens of megabytes each, more than a plugin can read at once.

## Limits

- Reading history needs `grep`, so it works on macOS and Linux. On Windows the live count still works.
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
