import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { disableHint, parseHistory, pluginsTable, rows } from '../hooks/register'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-21T12:00:00Z')

const PANE = {
  plugin: 'skill-census',
  component: 'Pane',
  requestId: 'skill-census',
  props: {
    title: 'Skill census',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const HISTORY = [
  '2026-10-20T10:00:00.000Z\tsuperpowers:brainstorming',
  '2026-10-01T10:00:00.000Z\tsuperpowers:brainstorming',
  '2026-10-19T10:00:00.000Z\tcompact',
  // after the mod started counting live: left to the live hook
  '2026-10-21T12:30:00.000Z\tmr-description',
  'garbage line',
].join('\n')

const RAN = { exitCode: 0, stdout: HISTORY, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }

const COMMAND = {
  command: 'skill-census',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

function engine(on: On, { store = {}, scan = Promise.resolve() } = {}) {
  mock.store(on, store)
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/me' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({
    value: [
      { name: 'compact', description: '', source: 'builtin' },
      { name: 'mr-description', description: '', source: 'user' },
      { name: 'superpowers:brainstorming', description: '', source: 'plugin', plugin: 'superpowers' },
      { name: 'superpowers:writing-plans', description: '', source: 'plugin', plugin: 'superpowers' },
      { name: 'ecc:plan', description: '', source: 'plugin', plugin: 'ecc' },
      { name: 'ecc:tdd', description: '', source: 'plugin', plugin: 'ecc' },
      // added from outside Claude Code settings: no id to disable it by
      { name: 'figma:use', description: '', source: 'plugin', plugin: 'figma' },
    ],
  }))
  on('settings.read', () => ({
    value: { enabledPlugins: { 'ecc@ecc': true, 'superpowers@claude-plugins-official': true } },
  }))
  // `scan` holds the history read back, as a slow first run does.
  on('process.run', async () => {
    await scan
    return { value: RAN }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  return clock
}

test('parseHistory counts uses and the latest one, before the cutoff only', async () => {
  const found = parseHistory(HISTORY, NOW)

  expect(found['superpowers:brainstorming']).toEqual({
    count: 2,
    last: Date.parse('2026-10-20T10:00:00.000Z'),
  })
  expect(found['compact']?.count).toBe(1)
  expect(found['mr-description']).toBeUndefined()
})

test('builtins are left out and plugins are summed', async () => {
  const inv = {
    skills: [
      { name: 'superpowers:brainstorming', plugin: 'superpowers' },
      { name: 'superpowers:writing-plans', plugin: 'superpowers' },
    ],
    builtins: ['compact'],
    pluginIds: {},
  }
  const list = rows(inv, {
    'superpowers:brainstorming': { count: 3, last: NOW - 2 * DAY },
    compact: { count: 9, last: NOW },
  })

  expect(list.map(r => r.name)).toEqual(['superpowers:brainstorming', 'superpowers:writing-plans'])
  expect(pluginsTable(list, NOW)).toContain('| superpowers | 1 / 2 | 3 | 2d ago |')
})

test('the hint lists never-used plugins, biggest first, with their disable command', async () => {
  const inv = {
    skills: [
      { name: 'ecc:plan', plugin: 'ecc' },
      { name: 'ecc:tdd', plugin: 'ecc' },
      { name: 'Notion:search', plugin: 'Notion' },
      { name: 'figma:use', plugin: 'figma' },
      { name: 'superpowers:brainstorming', plugin: 'superpowers' },
      { name: 'my-skill' },
    ],
    builtins: [],
    pluginIds: { ecc: 'ecc@ecc', notion: 'notion@claude-plugins-official' },
  }
  const hint = disableHint(rows(inv, { 'superpowers:brainstorming': { count: 1, last: NOW } }), inv.pluginIds)

  expect(hint).toContain('(3)')
  expect(hint).toContain('| ecc | 2 | `claude plugin disable ecc@ecc` |')
  // the id is matched whatever the case of the name the menu shows
  expect(hint).toContain('`claude plugin disable notion@claude-plugins-official`')
  expect(hint).toContain('| figma | 1 | not in your Claude Code settings')
  expect(hint.indexOf('| ecc |')).toBeLessThan(hint.indexOf('| figma |'))
  expect(hint).not.toContain('superpowers')
  expect(hint).not.toContain('your skills')
  expect(disableHint(rows({ ...inv, skills: [] }, {}), {})).toBe('')
})

test('history and live uses show in the pane, on every surface', async ($, on) => {
  engine(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // A skill named without its plugin, as the engine may hand it.
  await $.skill.prompt({ skill: 'brainstorming', pluginName: 'superpowers', text: 'go' })
  await $.command.run({
    command: 'skill-census',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const table = await ui.find({ type: 'Markdown' })

    expect(table?.text).toContain('| `superpowers:brainstorming` | 3 | today |')
    expect(table?.text).toContain('| `superpowers:writing-plans` | 0 | never |')
    expect(table?.text).not.toContain('compact')

    await ui.press({ key: 'plugins' })
    const plugins = (await ui.find({ type: 'Markdown' }))?.text
    expect(plugins).toContain('| superpowers | 1 / 2 | 3 | today |')
    expect(plugins).toContain('| ecc | 2 | `claude plugin disable ecc@ecc` |')
    expect(plugins).toContain('| figma | 1 | not in your Claude Code settings')
    await ui.press({ key: 'skills' })
    await ui.unmount()
  }
})

type TestEngine = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

// Uses of superpowers:brainstorming in the Skills table, once background work has settled.
async function brainstorming($: TestEngine, clock: { advance: (ms: number) => Promise<void> }) {
  await clock.advance(0)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'skills' })
  const text = (await ui.find({ type: 'Markdown' }))?.text ?? ''
  await ui.unmount()
  return text.match(/\| `superpowers:brainstorming` \| (\d+) \|/)?.[1]
}

test('two sessions importing at once count history once', async ($, on) => {
  const clock = engine(on)

  await Promise.all([
    $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true }),
    $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true }),
  ])
  await $.command.run(COMMAND)

  expect(await brainstorming($, clock)).toBe('2')
})

test('a 0.1.0 store with doubled counts is recounted from the transcripts', async ($, on) => {
  const clock = engine(on, {
    store: {
      usage: { 'superpowers:brainstorming': { count: 4, last: NOW - DAY } },
      imported: true,
      liveSince: NOW - DAY,
    },
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(COMMAND)

  expect(await brainstorming($, clock)).toBe('2')
})

test('while history is read, no plugin is called unused', async ($, on) => {
  let finish = () => {}
  const clock = engine(on, { scan: new Promise<void>(resolve => (finish = resolve)) })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const { text } = await $.command.run(COMMAND)

  expect(text).toContain('Still reading past transcripts')
  expect(text).not.toContain('Never used')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'plugins' })
  expect((await ui.find({ type: 'Markdown' }))?.text).not.toContain('Never used')
  await ui.unmount()

  finish()
  await $.command.run(COMMAND)
  expect(await brainstorming($, clock)).toBe('2')
})
