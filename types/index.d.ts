// Uses per skill name; `last` is epoch ms, 0 when never used.
export type Usage = Record<string, { count: number; last: number }>
export type Skill = { name: string; plugin?: string }
// pluginIds: enabled plugin ids from settings, keyed by lowercased plugin name.
export type Inventory = { skills: Skill[]; builtins: string[]; pluginIds: Record<string, string> }
export type View = 'skills' | 'plugins'

declare module 'claude-code' {
  interface PluginState {
    'skill-census': {
      usage: Usage
      inventory: Inventory
      view: View
      isScanning: boolean
    }
  }
}
