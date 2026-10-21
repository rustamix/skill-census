import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseHistory, pluginsTable, rows } from '../hooks/register'

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

function engine(on: On) {
  mock.store(on)
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/me' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({
    value: [
      { name: 'compact', description: '', source: 'builtin' },
      { name: 'mr-description', description: '', source: 'user' },
      { name: 'superpowers:brainstorming', description: '', source: 'plugin', plugin: 'superpowers' },
      { name: 'superpowers:writing-plans', description: '', source: 'plugin', plugin: 'superpowers' },
    ],
  }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: HISTORY,
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
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
  }
  const list = rows(inv, {
    'superpowers:brainstorming': { count: 3, last: NOW - 2 * DAY },
    compact: { count: 9, last: NOW },
  })

  expect(list.map(r => r.name)).toEqual(['superpowers:brainstorming', 'superpowers:writing-plans'])
  expect(pluginsTable(list, NOW)).toContain('| superpowers | 1 / 2 | 3 | 2d ago |')
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
    expect((await ui.find({ type: 'Markdown' }))?.text).toContain('| superpowers | 1 / 2 | 3 | today |')
    await ui.press({ key: 'skills' })
    await ui.unmount()
  }
})
