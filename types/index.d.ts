export type Handoff = 'full' | 'lean'

export type Settings = { isEnabled: boolean; target: number; handoff: Handoff }

export type Usage = { percent: number; tokens: number; window: number }

export type Menu = { draft: Settings; window: number }

declare module 'claude-code' {
  interface PluginState {
    'context-pilot': { menu: Menu | null; target: number | null; live: Settings | null; usage: Usage | null; enabled: boolean | null }
  }
}
