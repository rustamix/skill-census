import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Inventory, Usage, View } from '../types'

const PANE = 'skill-census'
const DAY = 86_400_000

const usage = atom({ plugin: 'skill-census', key: 'usage' } as const, {})
const inventory = atom({ plugin: 'skill-census', key: 'inventory' } as const, {
  skills: [],
  builtins: [],
})
const view = atom({ plugin: 'skill-census', key: 'view' } as const, 'skills')
const isScanning = atom({ plugin: 'skill-census', key: 'isScanning' } as const, false)

// Prints "<timestamp>\t<skill>" for every Skill tool call and every typed /command in
// the transcripts under $1. JSON escapes quotes inside strings, so the unescaped
// patterns only match real structure, never a transcript that quotes them.
const SCAN = `grep -rhE --include='*.jsonl' -e '"name":"Skill","input":\\{"skill":"' -e '<command-name>/' "$1" | awk '
{ ts = ""; if (match($0, /"timestamp":"[^"]+"/)) ts = substr($0, RSTART + 13, RLENGTH - 14) }
/"type":"assistant"/ {
  s = $0
  while (match(s, /"name":"Skill","input":\\{"skill":"[^"]+"/)) {
    print ts "\\t" substr(s, RSTART + 33, RLENGTH - 34); s = substr(s, RSTART + RLENGTH)
  }
  next
}
/"type":"user"/ && !/"tool_result"/ && match($0, /<command-name>\\/[^<]+<\\/command-name>/) {
  print ts "\\t" substr($0, RSTART + 15, RLENGTH - 30)
}'`

export function parseHistory(text: string, before: number): Usage {
  const found: Usage = {}
  for (const line of text.split('\n')) {
    const [stamp, name] = line.split('\t')
    const at = Date.parse(stamp ?? '')
    if (!name || !(at < before)) continue
    const one = (found[name] ??= { count: 0, last: 0 })
    one.count += 1
    one.last = Math.max(one.last, at)
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

// Store writes are read-modify-write, so they go one at a time.
let writes: Promise<unknown> = Promise.resolve()
function add($: EngineInterface, extra: Usage) {
  const run = writes.then(async () => {
    const merged = merge(((await $.store.get('usage')) ?? {}) as Usage, extra)
    await $.store.set('usage', merged)
    await update($, usage, () => merged)
  })
  writes = run.catch(() => undefined)
  return run
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
  await update($, inventory, () => ({ skills, builtins }))
}

async function importHistory($: EngineInterface, liveSince: number) {
  if (await $.store.get('imported')) return
  await update($, isScanning, () => true)
  try {
    const root =
      (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
    const ran = await $.process.run(['sh', '-c', SCAN, 'sh', `${root}/projects`], {
      timeoutMs: 600_000,
    })
    if (ran.exitCode !== 0) throw new Error(ran.stderr.slice(0, 200))
    await add($, parseHistory(ran.stdout, liveSince))
    await $.store.set('imported', true)
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
    group: installed.get(name) ?? pluginOf(name) ?? 'your skills',
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

export function pluginsTable(list: Row[], now: number) {
  const groups = new Map<string, { name: string; total: number; used: number; count: number; last: number }>()
  for (const r of list.filter(r => r.isInstalled)) {
    const g = groups.get(r.group) ?? { name: r.group, total: 0, used: 0, count: 0, last: 0 }
    g.total += 1
    g.used += r.count > 0 ? 1 : 0
    g.count += r.count
    g.last = Math.max(g.last, r.last)
    groups.set(r.group, g)
  }
  const lines = [...groups.values()]
    .sort(byLast)
    .map(g => `| ${g.name} | ${g.used} / ${g.total} | ${g.count} | ${ago(g.last, now)} |`)

  return ['| Plugin | Skills used | Uses | Last used |', '| --- | ---: | ---: | --- |', ...lines].join('\n')
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
    let liveSince = (await $.store.get('liveSince')) as number | undefined
    if (liveSince === undefined) {
      liveSince = await $.clock.now()
      await $.store.set('liveSince', liveSince)
    }
    const saved = ((await $.store.get('usage')) ?? {}) as Usage
    await update($, usage, () => saved)
    void refreshInventory($)
    void importHistory($, liveSince)

    return next(e)
  })

  // Fires for the Skill tool, a typed /skill and a skill preloaded into a subagent.
  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    const name = e.pluginName && !e.skill.includes(':') ? `${e.pluginName}:${e.skill}` : e.skill
    await add($, { [name]: { count: 1, last: await $.clock.now() } }).catch(() => undefined)

    return result
  })

  on('command.run', { command: PANE }, async $ => {
    await refreshInventory($)
    const opened = await $.ui.open({ id: PANE, title: 'Skill census' })
    const list = rows(await read($, inventory), await read($, usage))
    const where = opened.isPlaced ? 'Opened the Skill census pane.' : ''

    return { text: `${summary(list)}. ${where}\n\n${pluginsTable(list, await $.clock.now())}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const list = rows(await read($, inventory), await read($, usage))
    const current: View = await read($, view)
    const now = await $.clock.now()
    const pick = (to: View) => () => update($, view, () => to)

    return (
      <Box flexDirection="column">
        <Text>
          {summary(list)}
          {(await read($, isScanning)) ? ' · reading past transcripts…' : ''}
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
        <Markdown text={current === 'skills' ? skillsTable(list, now) : pluginsTable(list, now)} />
      </Box>
    )
  })
}
