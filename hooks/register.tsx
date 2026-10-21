import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Inventory, Usage, View } from '../types'

const PANE = 'skill-census'
const DAY = 86_400_000
const SCANNING =
  'Still reading past transcripts (about 15 seconds on the first run), so these counts are incomplete.'

const usage = atom({ plugin: 'skill-census', key: 'usage' } as const, {})
const inventory = atom({ plugin: 'skill-census', key: 'inventory' } as const, {
  skills: [],
  builtins: [],
  pluginIds: {},
})
const view = atom({ plugin: 'skill-census', key: 'view' } as const, 'skills')
const isScanning = atom({ plugin: 'skill-census', key: 'isScanning' } as const, false)

const COMMAND_NAME = /<command-name>\/([^<\s]+)<\/command-name>/

type Block = { type?: string; name?: string; text?: unknown; input?: { skill?: unknown } }
type Line = { type?: string; timestamp?: string; message?: { content?: string | Block[] } }

// Counts Skill tool calls and typed /commands in transcript lines (JSONL), before `before`.
export function parseHistory(text: string, before: number): Usage {
  const found: Usage = {}
  const count = (name: string, at: number) => {
    const one = (found[name] ??= { count: 0, last: 0 })
    one.count += 1
    one.last = Math.max(one.last, at)
  }
  for (const line of text.split('\n')) {
    let row: Line
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const at = Date.parse(row?.timestamp ?? '')
    if (!(at < before)) continue
    const content = row.message?.content
    if (row.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use' && block.name === 'Skill' && typeof block.input?.skill === 'string') {
          count(block.input.skill, at)
        }
      }
    } else if (row.type === 'user') {
      // Only what was typed counts: a tool result can echo command tags it was handed.
      const texts =
        typeof content === 'string'
          ? [content]
          : (content ?? []).filter(b => b?.type === 'text').map(b => String(b.text))
      const name = texts.map(t => COMMAND_NAME.exec(t)?.[1]).find(n => n !== undefined)
      if (name) count(name, at)
    }
  }
  return found
}

function merge(base: Usage, extra: Usage): Usage {
  const merged = { ...base }
  for (const [name, one] of Object.entries(extra)) {
    const had = merged[name] ?? { count: 0, last: 0 }
    merged[name] = { count: had.count + one.count, last: Math.max(had.last, one.last) }
  }
  return merged
}

// History and live uses are kept apart and history is replaced, never added to, so two
// sessions importing at once write the same history instead of counting it twice.
// Store writes are read-modify-write, so they go one at a time.
// shortcut: two processes adding live uses at the same moment can lose one; fine for counts.
let writes: Promise<unknown> = Promise.resolve()
function serially(task: () => Promise<void>) {
  const run = writes.then(task)
  writes = run.catch(() => undefined)
  return run
}

async function showUsage($: EngineInterface) {
  const history = ((await $.store.get('history')) ?? {}) as Usage
  const live = ((await $.store.get('live')) ?? {}) as Usage
  await update($, usage, () => merge(history, live))
}

function addLive($: EngineInterface, extra: Usage) {
  return serially(async () => {
    await $.store.set('live', merge(((await $.store.get('live')) ?? {}) as Usage, extra))
    await showUsage($)
  })
}

const pluginOf = (name: string) =>
  name.includes(':') ? name.slice(0, name.indexOf(':')) : undefined

async function refreshInventory($: EngineInterface) {
  const commands = await $.command.list()
  const skills = commands
    .filter(c => (c.source === 'user' || c.source === 'plugin') && c.name !== PANE)
    .map(c => ({
      name: c.name,
      plugin: c.plugin ?? pluginOf(c.name),
    }))
  const builtins = commands.filter(c => c.source === 'builtin').map(c => c.name)
  // Without settings the hint loses its commands, not the tables.
  const settings = await $.settings.read().catch(() => undefined)
  const enabled = (settings?.enabledPlugins ?? {}) as Record<string, unknown>
  const pluginIds = Object.fromEntries(
    Object.keys(enabled)
      .filter(id => enabled[id] === true)
      .map(id => [id.split('@')[0]!.toLowerCase(), id]),
  )
  await update($, inventory, () => ({ skills, builtins, pluginIds }))
}

async function importHistory($: EngineInterface, liveSince: number) {
  if ((await $.store.get('history')) !== undefined) return
  await update($, isScanning, () => true)
  try {
    const root =
      (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
    // The one program the mod runs: grep, keeping the lines with a Skill tool call or a typed
    // /command. JSON escapes quotes inside strings, so the first pattern only matches real
    // structure; parseHistory checks the rest. Streamed: the matches outgrow a one-shot run.
    const grep = $.process.spawn({
      argv: [
        'grep',
        '-rhE',
        '--include=*.jsonl',
        '-e',
        '"name":"Skill","input":\\{"skill":"',
        '-e',
        '<command-name>/',
        `${root}/projects`,
      ],
    })
    let out = ''
    let err = ''
    for await (const { stream, text } of grep) {
      if (stream === 'stdout') out += text
      else err += text
    }
    const { code } = await grep.result
    // grep exits 1 when nothing matched: no history yet.
    if (code !== 0 && code !== 1) throw new Error(err.slice(0, 200) || `grep exited with ${code}`)
    const history = parseHistory(out, liveSince)
    await serially(async () => {
      await $.store.set('history', history)
      await showUsage($)
    })
  } catch (error) {
    $.ui.toast(`skill-census: could not read past transcripts (${String(error)})`)
  } finally {
    await update($, isScanning, () => false)
  }
}

type Row = { name: string; group: string; count: number; last: number; isInstalled: boolean }

export function rows(inv: Inventory, use: Usage): Row[] {
  const builtins = new Set(inv.builtins)
  const installed = new Map(inv.skills.map(s => [s.name, s.plugin]))
  const names = new Set([...installed.keys(), ...Object.keys(use).filter(n => !builtins.has(n))])

  return [...names].map(name => ({
    name,
    group: installed.get(name) ?? pluginOf(name) ?? OWN,
    count: use[name]?.count ?? 0,
    last: use[name]?.last ?? 0,
    isInstalled: installed.has(name),
  }))
}

function ago(last: number, now: number) {
  if (last === 0) return 'never'
  const days = Math.floor((now - last) / DAY)

  return days === 0 ? 'today' : `${days}d ago`
}

const byLast = (a: { last: number; name: string }, b: { last: number; name: string }) =>
  a.last - b.last || a.name.localeCompare(b.name)

export function skillsTable(list: Row[], now: number) {
  const lines = [...list].sort(byLast).map(r => {
    const name = r.isInstalled ? `\`${r.name}\`` : `~~${r.name}~~ (not installed)`
    return `| ${name} | ${r.count} | ${ago(r.last, now)} |`
  })

  return ['| Skill | Uses | Last used |', '| --- | ---: | --- |', ...lines].join('\n')
}

const OWN = 'your skills'

function pluginGroups(list: Row[]) {
  const groups = new Map<string, { name: string; total: number; used: number; count: number; last: number }>()
  for (const r of list.filter(r => r.isInstalled)) {
    const g = groups.get(r.group) ?? { name: r.group, total: 0, used: 0, count: 0, last: 0 }
    g.total += 1
    g.used += r.count > 0 ? 1 : 0
    g.count += r.count
    g.last = Math.max(g.last, r.last)
    groups.set(r.group, g)
  }
  return [...groups.values()]
}

export function pluginsTable(list: Row[], now: number) {
  const lines = pluginGroups(list)
    .sort(byLast)
    .map(g => `| ${g.name} | ${g.used} / ${g.total} | ${g.count} | ${ago(g.last, now)} |`)

  return ['| Plugin | Skills used | Uses | Last used |', '| --- | ---: | ---: | --- |', ...lines].join('\n')
}

// Never-used plugins, biggest first, with the command that turns each off; '' when none.
export function disableHint(list: Row[], pluginIds: Record<string, string>) {
  const unused = pluginGroups(list)
    .filter(g => g.name !== OWN && g.used === 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
  if (unused.length === 0) return ''
  const lines = unused.map(g => {
    const id = pluginIds[g.name.toLowerCase()]
    const how = id ? `\`claude plugin disable ${id}\`` : 'not in your Claude Code settings: turn it off where it was added'
    return `| ${g.name} | ${g.total} | ${how} |`
  })

  return [
    `**Never used, can be turned off** (${unused.length}):`,
    '',
    '| Plugin | Skills | Turn off |',
    '| --- | ---: | --- |',
    ...lines,
    '',
    'Run the command in a shell, or use `/plugin` in a terminal session (desktop app: **+** → **Plugins**). `claude plugin enable` brings a plugin back.',
  ].join('\n')
}

function summary(list: Row[]) {
  const installed = list.filter(r => r.isInstalled)
  const used = installed.filter(r => r.count > 0).length

  return `${used} of ${installed.length} skills used, ${installed.length - used} never`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: PANE,
      description: 'Show how often each skill is used',
    })
    // 0.1.0 kept history and live uses in one 'usage' key and could count history twice:
    // drop it and recount from the transcripts.
    if ((await $.store.get('usage')) !== undefined) {
      for (const key of ['usage', 'imported', 'liveSince']) await $.store.delete(key)
    }
    let liveSince = (await $.store.get('liveSince')) as number | undefined
    if (liveSince === undefined) {
      liveSince = await $.clock.now()
      await $.store.set('liveSince', liveSince)
    }
    await showUsage($)
    void refreshInventory($)
    void importHistory($, liveSince)

    return next(e)
  })

  // Fires for the Skill tool, a typed /skill and a skill preloaded into a subagent.
  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    const name = e.pluginName && !e.skill.includes(':') ? `${e.pluginName}:${e.skill}` : e.skill
    await addLive($, { [name]: { count: 1, last: await $.clock.now() } }).catch(() => undefined)

    return result
  })

  on('command.run', { command: PANE }, async $ => {
    await refreshInventory($)
    const opened = await $.ui.open({ id: PANE, title: 'Skill census' })
    const inv = await read($, inventory)
    const list = rows(inv, await read($, usage))
    const where = opened.isPlaced ? 'Opened the Skill census pane.' : ''
    // A partial count would call every plugin unused: no advice until history is in.
    if (await read($, isScanning)) {
      return {
        text: `${summary(list)}. ${where}\n\n${SCANNING} Run /skill-census again in a few seconds; the pane updates by itself.`,
      }
    }
    const tables = [pluginsTable(list, await $.clock.now()), disableHint(list, inv.pluginIds)]

    return { text: `${summary(list)}. ${where}\n\n${tables.filter(Boolean).join('\n\n')}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const inv = await read($, inventory)
    const list = rows(inv, await read($, usage))
    const current: View = await read($, view)
    const now = await $.clock.now()
    const pick = (to: View) => () => update($, view, () => to)
    const scanning = await read($, isScanning)
    const hint = scanning ? SCANNING : disableHint(list, inv.pluginIds)

    return (
      <Box flexDirection="column">
        <Text>
          {summary(list)}
          {scanning ? ' · reading past transcripts…' : ''}
        </Text>
        <Box>
          <Button
            key="skills"
            label="Skills"
            variant={current === 'skills' ? 'primary' : 'secondary'}
            onPress={pick('skills')}
          />
          <Button
            key="plugins"
            label="Plugins"
            variant={current === 'plugins' ? 'primary' : 'secondary'}
            onPress={pick('plugins')}
          />
        </Box>
        <Markdown
          text={
            current === 'skills'
              ? skillsTable(list, now)
              : [pluginsTable(list, now), hint].filter(Boolean).join('\n\n')
          }
        />
      </Box>
    )
  })
}
