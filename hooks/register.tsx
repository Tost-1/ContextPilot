import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnCompleteInput } from 'claude-code'

import type { Account, Handoff, Settings, Spend, Usage } from '../types'

const CELL = 6
const STOPS = [50, 100, 150, 200, 250, 300, 400, 500, 600, 700, 800, 900].map(k => k * 1000)
const DEFAULTS: Settings = { isEnabled: false, target: 300_000, handoff: 'full' }
const menu = atom({ plugin: 'context-pilot', key: 'menu' } as const, null)
const target = atom({ plugin: 'context-pilot', key: 'target' } as const, null)
const current = atom({ plugin: 'context-pilot', key: 'live' } as const, null)
const usage = atom({ plugin: 'context-pilot', key: 'usage' } as const, null)
const enabled = atom({ plugin: 'context-pilot', key: 'enabled' } as const, null)
const account = atom({ plugin: 'context-pilot', key: 'account' } as const, null)

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const POLL = 5 * 60_000

export const BAR = 20
const METER = 5

const MODES = [
  { id: 'default', label: '⏸ manual mode on' },
  { id: 'acceptEdits', label: '⏵⏵ accept edits on' },
  { id: 'plan', label: '⏸ plan mode on' },
  { id: 'bypassPermissions', label: '⏵⏵ bypass permissions on' },
  { id: 'auto', label: '⏵⏵ auto mode on' },
]

export function leaving(hint: string) {
  return MODES.findIndex(m => hint.startsWith(m.label.slice(m.label.indexOf(' ') + 1)))
}

export function level(percent: number) {
  if (percent >= 90) return 'error'
  if (percent >= 75) return 'warning'
  return 'success'
}

export function offset(mode: string | null) {
  const m = MODES.find(m => m.id === mode)
  return m ? m.label.length + 3 : 0
}

export function glyph(mode: string | null) {
  const m = MODES.find(m => m.id === mode)
  return m ? m.label.indexOf(' ') + 1 : 2
}

export function gauge(u: Usage, limit: number | null) {
  const percent = limit ? Math.round((u.tokens / limit) * 100) : u.percent
  return { percent, figures: `${short(u.tokens)} / ${limit ? `${short(limit)} target` : short(u.window)}` }
}

export function fill(percent: number, width: number) {
  const exact = (Math.min(Math.max(percent, 0), 100) / 100) * width
  return exact > 0 ? Math.max(1, Math.round(exact)) : 0
}

export function dollars(usd: number) {
  return `$${usd.toFixed(2)}`
}

export function money(usd: number) {
  return `$${Math.round(usd).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

type Minor = { amount_minor: number; exponent: number } | null
type Report = {
  five_hour?: { utilization: number | null } | null
  seven_day?: { utilization: number | null } | null
  spend?: { used?: Minor; limit?: Minor } | null
  extra_usage?: { is_enabled: boolean; monthly_limit: number | null; used_credits: number | null; decimal_places?: number | null } | null
  wattle_ember?: { limit_dollars?: number | null; used_dollars?: number | null } | null
}

function minor(m: Minor | undefined) {
  return m ? m.amount_minor / 10 ** m.exponent : undefined
}

function spendOf(r: Report): Spend | undefined {
  const used = minor(r.spend?.used)
  const limit = minor(r.spend?.limit)
  if (used !== undefined && limit) return { used, limit }
  const extra = r.extra_usage
  if (extra?.is_enabled && extra.monthly_limit && extra.used_credits !== null) {
    const scale = 10 ** (extra.decimal_places ?? 2)
    return { used: extra.used_credits / scale, limit: extra.monthly_limit / scale }
  }
  const credit = r.wattle_ember
  if (credit?.limit_dollars && typeof credit.used_dollars === 'number') return { used: credit.used_dollars, limit: credit.limit_dollars }
  return undefined
}

export function accountOf(r: Report): Account {
  return { fiveHour: r.five_hour?.utilization ?? undefined, week: r.seven_day?.utilization ?? undefined, spend: spendOf(r) }
}

export type Meter = { label: string; text: string; compact: string; percent: number }

function windows(fiveHour: number | undefined, week: number | undefined): Meter[] {
  if (fiveHour === undefined && week === undefined) return []
  const meter = (label: string, tag: string, percent = 0) => ({ label, text: `${Math.round(percent)}%`, compact: `${tag} ${Math.round(percent)}%`, percent })
  return [meter('5h', '5h', fiveHour), meter('week', 'wk', week)]
}

export function meters(u: Usage | null, a: Account | null): Meter[] {
  if (u?.fiveHour !== undefined || u?.week !== undefined) return windows(u.fiveHour ?? a?.fiveHour, u.week ?? a?.week)
  const s = a?.spend
  if (s) return [{ label: 'month', text: `${money(s.used)} / ${money(s.limit)}`, compact: `$${short(Math.round(s.used))}/$${short(s.limit)}`, percent: (s.used / s.limit) * 100 }]
  return windows(a?.fiveHour, a?.week)
}

let seed: number | undefined

async function count($: EngineInterface, breakdown: 'summary' | 'full') {
  return (await $.session.usage({ breakdown })).context.breakdown?.totalTokens
}

async function refresh($: EngineInterface) {
  const { context, cost, rateLimits } = await $.session.usage()
  const tokens = context.tokens === undefined ? (seed ?? (await count($, 'full'))) : ((await count($, 'summary')) ?? context.tokens)
  const windowOf = (kind: string) => (rateLimits ?? []).find(r => r.kind === kind)?.percentUsed
  const next: Usage | null =
    tokens === undefined
      ? null
      : { percent: Math.round((tokens / context.window) * 100), tokens, window: context.window, usd: cost?.usd, fiveHour: windowOf('five_hour'), week: windowOf('seven_day') }
  await update($, usage, () => next)
}

let polledAt = -Infinity

async function poll($: EngineInterface) {
  const now = await $.clock.now()
  if (now - polledAt < POLL) return
  polledAt = now
  const auth = await $.session.authorize()
  if (!auth) return
  const res = await $.http.fetch(USAGE_URL, { auth: auth.handle })
  if (res.ok) await update($, account, () => accountOf(JSON.parse(res.text) as Report))
}

let mode: string | null = null

function track($: EngineInterface, next: string | undefined) {
  if (!next || next === mode) return
  mode = next
  $.ui.invalidate('ui.render')
}

async function initialMode($: EngineInterface) {
  const { stdout } = await $.process.run(['sh', '-c', 'ps -o args= -p $PPID'])
  const flag = stdout.match(/--permission-mode[ =](\S+)/)?.[1]
  if (flag) return flag
  if (stdout.includes('--dangerously-skip-permissions')) return 'bypassPermissions'
  const permissions = (await $.settings.read()).permissions as { defaultMode?: string } | undefined
  return permissions?.defaultMode ?? 'default'
}

export const CHECKPOINT = 'docs/CHECKPOINT.md'
export const OWN = '.context-pilot'

const FULL_SECTIONS = `
   ## The task
   <the user's goal and original request, quoted verbatim where possible>

   ## The user's instructions
   <every instruction, preference and correction the user gave this session, quoted>

   ## Current state
   <what is done (with commits), in progress and broken; files changed and why, as path:line>

   ## Decisions
   <what was decided and why, including approaches tried and rejected>
`

export function checkpointPrompt(tokens: number, handoff: Handoff, path: string, isProject: boolean, mark: string) {
  return `Context pilot: context is at ${short(tokens)}. This conversation will be cleared as soon as this turn ends, and the next context resumes from \`${path}\` alone. Write the checkpoint now.

**This is a checkpoint, not a winddown.** It is a fast mid-session context reset while work continues: nothing stops, nothing is verified. Do NOT stop agents, do NOT message them, do NOT start new work, do NOT ask the user anything, do NOT rewrite RESUME. Steps:

1. If the project has a checkpoint helper (e.g. \`tools/*checkpoint.sh\`), run it: machine, mode, HEAD, uncommitted files, commits since the last checkpoint. Its output goes at the bottom of the file.
2. If any agents are running, \`ListAgents\`: you need the live list for the table below.
3. **If \`docs/STATUS.md\` exists, CHECK IT AND BRING IT CURRENT IF IT IS STALE.** \`CHECKPOINT.md\` is the lead's head; \`STATUS.md\` is the project's state, and resume reads STATUS first. Read its Now / Next / Blocked and ask "is any line of this now false?" If a queued item has run, a claim has been refuted, or a wall has fallen, fix those lines. Do not rewrite it wholesale for tidiness; correct what is wrong. **A settled item moves from Next to Now with its result, it does not silently vanish.**
4. Write \`${path}\` (create its folder if needed), starting with the exact line \`<!-- context-pilot ${mark} -->\`. **REPLACE the file wholesale — never append, never keep a line you have not just re-verified.** A checkpoint is a snapshot of NOW, not a log; git holds the previous one.

   **Re-verify every row before it goes in:**
   - **in-flight table**: only agents \`ListAgents\` shows RIGHT NOW. One that reported, was shut down or died belongs under "just landed" with its commit, not in the respawn table.
   - **just landed**: each line names a commit, note path or id you can see in \`git log\`. If it is not committed, it is not landed: commit it or write it as a "do not do".
   - **next action**: is it still the next action, or did you already do it?
   - **do not do**: drop entries that no longer apply.

   Everything in it must be actionable cold:

   \`\`\`markdown
   <!-- context-pilot ${mark} -->
   # CHECKPOINT — <stamp>   (written mid-session; resume after a clear)

   **Context at checkpoint:** ${short(tokens)}
   **This supersedes RESUME only for what is IN FLIGHT.** RESUME/STATUS (where the project has them) remain the state of the project; this file is the state of the lead's head.
${handoff === 'full' ? FULL_SECTIONS : ''}
   ## In flight — the respawn table
   | agent (name/id) | model | what it is doing | if it died, respawn with |
   |---|---|---|---|
   | … | … | one line | the brief in two lines, or the note/commit it works from |

   ## Just landed, not yet in RESUME/STATUS
   - <result> — <where it is written: note path / id / commit>

   ## The next action
   <one sentence: the single next thing, with the exact command or brief if there is one>

   ## Do not do
   <anything the next context would plausibly get wrong: a paused thread, a retracted claim, a job that must not be started, a file another agent holds>

   <paste the helper's output here, if there is one>
   \`\`\`

   **The respawn column is the load-bearing part.** Write each brief tersely enough that a fresh lead can re-issue it without reading anything else.${handoff === 'full' ? ' The task, instructions, state and decisions sections must be complete enough that the next context can carry on without reading anything else and without asking the user.' : ''}
${isProject ? '5. If this is a git repository, \`git commit\` the checkpoint and any STATUS correction with **named paths only** (other agents may hold files).' : `5. Do not commit it: \`${OWN}/\` is gitignored.`}

Then reply in one line: checkpoint written, N agents in flight. Do not summarise the session.`
}

export function resumePrompt(path: string) {
  return `Context pilot: the conversation was just cleared to free up context. Resume from \`${path}\`.

If this project defines its own resume procedure (a \`.claude/commands/*.md\` file with a \`resume\` mode that reads \`${CHECKPOINT}\`), read that file and follow its resume mode exactly instead of the steps below: it carries your role and rules.

Otherwise:
1. Read \`${path}\` in full. It is your memory of the session: follow the instructions it records.
2. If the project has a checkpoint helper (e.g. \`tools/*checkpoint.sh\`), run it to see what changed while you were away.
3. If the checkpoint has a respawn table, \`ListAgents\` and compare: agents still listed survived, so do not message them just to check in; respawn any that are gone from the table's brief, under a NEW name.
4. Read only what the next action needs, not the whole project history. Do not redo finished work.
5. Agent reports or messages may arrive just before or after this one: they are new results, not repeats, so fold them in once you have read the checkpoint.
6. Say in one line what is in flight and what you are doing next, then do it.`
}

export function short(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`
  return `${n}`
}

export function stopsFor(window: number) {
  const stops = STOPS.filter(s => s < window)
  return stops.length > 0 ? stops : STOPS
}

export function parseTarget(text: string) {
  const match = text.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km]?)$/)
  if (!match) return null
  const scale = match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1
  return Math.round(Number(match[1]) * scale)
}

async function load($: EngineInterface): Promise<Settings> {
  const saved = (await $.store.get('settings')) as Partial<Settings> | undefined
  return { ...DEFAULTS, ...saved, isEnabled: pilot.isEnabled }
}

async function publish($: EngineInterface, settings: Settings) {
  await update($, target, () => (settings.isEnabled ? settings.target : null))
  await update($, current, () => settings)
  await update($, enabled, () => settings.isEnabled)
}

async function save($: EngineInterface, settings: Settings) {
  pilot.isEnabled = settings.isEnabled
  if (!settings.isEnabled) {
    pilot.phase = 'idle'
    pilot.turnId = null
    pilot.streak = 0
  }
  await $.store.set('settings', { target: settings.target, handoff: settings.handoff })
  await publish($, settings)
}

type Phase = 'idle' | 'checkpointing' | 'clearing' | 'resuming'

const pilot: {
  checkpoint: string
  phase: Phase
  startedAt: number
  isEnabled: boolean
  prompt: string
  turnId: string | null
  isInterrupted: boolean
  isRunning: boolean
  mark: string
  streak: number
  surface: string | null
} = {
  checkpoint: '',
  isEnabled: false,
  phase: 'idle',
  startedAt: 0,
  prompt: '',
  turnId: null,
  isInterrupted: false,
  isRunning: false,
  mark: '',
  streak: 0,
  surface: null,
}

async function declare($: EngineInterface) {
  await $.command.register({
    name: 'ctx',
    description: 'Context pilot: set the target that triggers checkpoint → /clear → resume',
    argumentHint: '[on|off|300k]',
    immediate: true,
  })
}

async function showStatus($: EngineInterface) {
  if (pilot.phase === 'checkpointing' || pilot.phase === 'clearing') return $.ui.status('pilot: checkpointing…')
  if (pilot.phase === 'resuming') return $.ui.status('pilot: resuming…')
  $.ui.status(undefined)
}

export async function locate($: EngineInterface) {
  const cwd = await $.session.cwd()
  const git = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel']).catch(() => null)
  const root = git?.exitCode === 0 ? git.stdout.trim() : cwd
  const isProject = (await $.fs.exists(`${root}/${CHECKPOINT}`)) || (await $.fs.exists(`${root}/docs/STATUS.md`))
  if (isProject) return { path: `${root}/${CHECKPOINT}`, isProject }
  await $.fs.write(`${root}/${OWN}/.gitignore`, '*\n')
  return { path: `${root}/${OWN}/CHECKPOINT.md`, isProject }
}

async function isCheckpointFresh($: EngineInterface) {
  try {
    return (await $.fs.read(pilot.checkpoint)).includes(pilot.mark)
  } catch {
    return false
  }
}

async function halt($: EngineInterface, message: string) {
  pilot.phase = 'idle'
  pilot.turnId = null
  $.ui.toast(message)
  await showStatus($)
}

async function submit($: EngineInterface, phase: Phase, text: string) {
  pilot.phase = phase
  pilot.prompt = text
  pilot.turnId = null
  await showStatus($)
  await $.prompt.submit({ text, asUser: true })
}

async function checkpoint($: EngineInterface, settings: Settings, tokens: number) {
  pilot.startedAt = await $.clock.now()
  pilot.mark = `${pilot.startedAt}-${crypto.randomUUID().slice(0, 8)}`
  pilot.isInterrupted = false
  const { path, isProject } = await locate($)
  pilot.checkpoint = path
  $.ui.toast(`Context pilot: ${short(tokens)} reached. Checkpointing, then /clear and resume.`)
  await submit($, 'checkpointing', checkpointPrompt(tokens, settings.handoff, path, isProject, pilot.mark))
}

export function isOurs(turnId: string, phase: Phase) {
  return pilot.phase === phase && pilot.turnId === turnId
}

async function advance($: EngineInterface, e: TurnCompleteInput) {
  const settings = await load($)
  const { context } = await $.session.usage()
  const isAnswered = e.reason === 'answer' && !e.isAborted

  if (pilot.phase === 'checkpointing') {
    if (!isOurs(e.turnId, 'checkpointing')) return
    if (!isAnswered) {
      await save($, { ...settings, isEnabled: false })
      return halt($, 'Context pilot: the checkpoint was stopped, so nothing was cleared. Turned off for this session.')
    }
    pilot.phase = 'clearing'
    if (!(await isCheckpointFresh($)))
      return halt($, "Context pilot: the checkpoint file wasn't written, so the session was not cleared.")
    if (pilot.isInterrupted) {
      pilot.phase = 'idle'
      $.ui.toast('Context pilot: a message arrived after the checkpoint, so it will checkpoint again before clearing.')
      if (!pilot.isRunning) await recheckpoint($)
      return
    }
    if (pilot.phase !== 'clearing' || !pilot.isEnabled) return
    await $.command.run({ command: 'clear' })
    await declare($)
    await publish($, settings)
    await submit($, 'resuming', resumePrompt(pilot.checkpoint))
    return
  }

  if (pilot.phase === 'clearing') return

  if (pilot.phase === 'resuming') {
    if (!isOurs(e.turnId, 'resuming')) return
    if (!isAnswered) return halt($, `Context pilot: the resume was interrupted. Ask Claude to read ${pilot.checkpoint} to pick up where it left off.`)
    pilot.phase = 'idle'
    if (context.tokens === undefined || context.tokens < settings.target) {
      pilot.streak = 0
      return showStatus($)
    }
    if (++pilot.streak >= 2) {
      await save($, { ...settings, isEnabled: false })
      return halt($, `Context pilot: two resumes in a row ended over the ${short(settings.target)} target. Turned off; raise the target with /ctx.`)
    }
    return checkpoint($, settings, context.tokens)
  }

  if (!settings.isEnabled || !isAnswered || context.tokens === undefined || context.tokens < settings.target) return
  pilot.streak = 0
  await checkpoint($, settings, context.tokens)
}

async function recheckpoint($: EngineInterface) {
  const settings = await load($)
  const { context } = await $.session.usage()
  if (settings.isEnabled && context.tokens !== undefined) await checkpoint($, settings, context.tokens)
}

export function step(target: number, stops: readonly number[], direction: 1 | -1) {
  const ahead = direction === 1 ? stops.find(s => s > target) : [...stops].reverse().find(s => s < target)
  return ahead ?? target
}

export function unreachable(target: number, window: number) {
  return target >= window ? ` Warning: this model's context window is ${short(window)}, so a ${short(target)} target is never reached.` : ''
}

export function summary(settings: Settings) {
  return `Context pilot ${settings.isEnabled ? 'on' : 'off'} · target ${short(settings.target)} · ${settings.handoff} handoff`
}

export function respond(key: string | undefined, draft: Settings, stops: readonly number[]): Partial<Settings> | null {
  if (key === ',' || key === '[') return { target: step(draft.target, stops, -1) }
  if (key === '.' || key === ']') return { target: step(draft.target, stops, 1) }
  if (key === ';') return { isEnabled: !draft.isEnabled }
  if (key === "'") return { handoff: draft.handoff === 'full' ? 'lean' : 'full' }
  return null
}

async function change($: EngineInterface, patch: Partial<Settings>) {
  const settings = { ...(await load($)), ...patch }
  await update($, menu, m => m && { ...m, draft: settings })
  await save($, settings)
  await showStatus($)
}

async function close($: EngineInterface) {
  if (await read($, menu)) await update($, menu, () => null)
}

export const register: Register = on => {

  mode = null

  on('classic.UserPromptSubmit', async ($, e, next) => {
    track($, e.permission_mode)
    return next(e)
  })

  on('classic.PostToolUse', async ($, e, next) => {
    track($, e.permission_mode)
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    seed = e.source === 'resume' || e.source === 'fork' ? e.context_tokens : undefined
    if (e.source === 'resume' || e.source === 'fork' || e.source === 'clear') {
      await publish($, await load($))
      await refresh($).catch(() => undefined)
    }
    return result
  })

  on('session.start', async ($, e, next) => {
    pilot.isEnabled = (await read($, enabled)) ?? false
    pilot.surface = e.surface
    await declare($)
    await showStatus($)
    await publish($, await load($))
    const result = await next(e)
    if (!mode) track($, await initialMode($))
    await refresh($).catch(() => undefined)
    poll($).catch(() => undefined)
    return result
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    await refresh($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) {
      pilot.isRunning = false
      $.clock.after(0, () => {
        advance($, e).catch(error => halt($, `Context pilot stopped: ${error instanceof Error ? error.message : error}`))
      })
    }
    await refresh($).catch(() => undefined)
    const u = await read($, usage)
    if (!e.agentId && (u?.fiveHour === undefined || u?.week === undefined)) poll($).catch(() => undefined)
    return result
  })

  on('turn.start', async ($, e, next) => {
    await close($)
    pilot.isRunning = true
    if (pilot.phase !== 'idle' && pilot.turnId === null && e.text === pilot.prompt) {
      pilot.turnId = e.turnId
      pilot.isInterrupted = false
    } else if (pilot.turnId !== null && pilot.turnId !== e.turnId) pilot.isInterrupted = true
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await close($)
    if (pilot.turnId !== null && e.turnId === pilot.turnId && e.text !== pilot.prompt) pilot.isInterrupted = true
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    const current = await read($, menu)
    if (!current) return next(e)
    const patch = respond(e.key?.ctrl || e.key?.meta ? undefined : e.key?.key, current.draft, stopsFor(current.window))
    if (!patch) {
      await close($)
      return next(e)
    }
    await change($, patch)
    return { text: e.text, cursor: e.cursor }
  })

  on('command.run', { command: 'ctx' }, async ($, e) => {
    const settings = await load($)
    const arg = e.args.trim().toLowerCase()
    const { context } = await $.session.usage()

    if (arg === 'on' || arg === 'off') {
      await save($, { ...settings, isEnabled: arg === 'on' })
      await showStatus($)
      return { text: `Context pilot ${arg === 'on' ? `on · ${short(settings.target)}` : 'off'}.${arg === 'on' ? unreachable(settings.target, context.window) : ''}` }
    }

    if (arg) {
      const target = parseTarget(arg)
      if (!target) return { text: 'Usage: /ctx [on|off|<target> e.g. 300k]' }
      await save($, { ...settings, target })
      await showStatus($)
      return { text: `Context pilot target set to ${short(target)}.${unreachable(target, context.window)}` }
    }

    if (pilot.surface === 'terminal') await update($, menu, () => ({ draft: settings, window: context.window }))
    return { text: `${summary(settings)}${unreachable(settings.target, context.window)}` }
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e) => {
    const current = await read($, menu)
    const { Box, Text } = $.ui.resolve(e)
    if (!current) {
      const u = await read($, usage)
      const limits = meters(u, await read($, account))
      const { percent, figures } = u ? gauge(u, await read($, target)) : { percent: 0, figures: '' }
      const filled = fill(percent, BAR)
      const color = level(percent)
      const left = leaving(e.props.hint)
      if (left >= 0) track($, MODES[(left + 1) % MODES.length]!.id)
      else if (e.props.hint === '') track($, 'default')
      const shift = e.surface === 'terminal' ? offset(mode) : 0

      return (
        <Box flexDirection="column">
          <Box height={1}>
            <Text dimColor>{left >= 0 ? '' : e.props.hint}</Text>
          </Box>
          <Box height={1}>
            <Box position="absolute" left={-shift}>
              <Text>{' '.repeat(glyph(mode))}</Text>
              <Text dimColor>{'context '}</Text>
              <Text color={color}>{'━'.repeat(filled)}</Text>
              <Text dimColor>{'─'.repeat(BAR - filled)}</Text>
              {u ? <Text color={color}>{` ${percent}%`}</Text> : null}
              {u ? <Text dimColor>{` · ${figures}`}</Text> : null}
              {u?.usd !== undefined ? <Text dimColor>{` · ${dollars(u.usd)}`}</Text> : null}
              {limits.map(m => (
                <Text>
                  <Text dimColor>{` · ${m.label} `}</Text>
                  <Text color={level(m.percent)}>{m.text}</Text>
                </Text>
              ))}
            </Box>
          </Box>
        </Box>
      )
    }
    const { draft } = current
    const stops = stopsFor(current.window)
    const width = stops.length * CELL
    const at = stops.indexOf(draft.target)
    const mark = at < 0 ? -1 : at * CELL + Math.floor(CELL / 2)

    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Context target</Text>
        <Box flexDirection="row" marginTop={1}>
          <Box flexDirection="column" marginLeft={8}>
            <Box width={width} justifyContent="space-between">
              <Text>Sooner</Text>
              <Text>Later</Text>
            </Box>
            <Text>{mark < 0 ? '─'.repeat(width) : `${'─'.repeat(mark)}▲${'─'.repeat(width - mark - 1)}`}</Text>
            <Box flexDirection="row">
              {stops.map(stop => (
                <Box width={CELL} justifyContent="center">
                  <Text color={stop === draft.target ? 'success' : undefined} bold={stop === draft.target} dimColor={stop !== draft.target}>
                    {short(stop)}
                  </Text>
                </Box>
              ))}
            </Box>
          </Box>
          <Box flexDirection="column" marginLeft={6}>
            <Box>
              <Text bold>Auto </Text>
              <Text dimColor={!draft.isEnabled}>{draft.isEnabled ? 'on' : 'off'}</Text>
            </Box>
            <Text dimColor>; to toggle</Text>
            <Box>
              <Text bold>Handoff </Text>
              <Text>{draft.handoff}</Text>
            </Box>
            <Text dimColor>' to switch</Text>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>{`At ${short(draft.target)}: writes a checkpoint (${draft.handoff}) → /clear → resumes from it`}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>, . to adjust · ; on/off · ' handoff · saved as you go · any other key closes</Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'CommandOutput', props: { command: 'ctx' } }, async ($, e, next) => {
    const settings = (await read($, current)) as Settings | null
    if (e.surface === 'terminal' || e.props.args.trim() || !settings) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const { context } = await $.session.usage()

    return (
      <Box flexDirection="column">
        <Text bold>Context target</Text>
        <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
          {stopsFor(context.window).map(stop => (
            <Button
              key={`stop:${stop}`}
              label={short(stop)}
              variant={stop === settings.target ? 'primary' : undefined}
              onPress={() => change($, { target: stop })}
            />
          ))}
        </Box>
        <Box flexDirection="row" marginTop={1}>
          <Button key="toggle" label={`Auto: ${settings.isEnabled ? 'on' : 'off'}`} variant={settings.isEnabled ? 'primary' : undefined} onPress={() => change($, { isEnabled: !settings.isEnabled })} />
          <Button key="handoff" label={`Handoff: ${settings.handoff}`} onPress={() => change($, { handoff: settings.handoff === 'full' ? 'lean' : 'full' })} />
        </Box>
        <Text dimColor>{`At ${short(settings.target)}: writes a checkpoint (${settings.handoff}) → /clear → resumes from it`}</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const u = await read($, usage)
    if (e.surface === 'terminal' || !u) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const limit = await read($, target)
    const { percent } = gauge(u, limit)
    const color = level(percent)
    const lit = fill(percent, METER)
    const limits = meters(u, await read($, account))

    return (
      <Box flexDirection="row">
        <Text>
          <Text color={color}>{'━'.repeat(lit)}</Text>
          <Text dimColor>{'─'.repeat(METER - lit)}</Text>
        </Text>
        <Text color={color}>{` ${percent}%`}</Text>
        {limits.length > 0 ? <Text dimColor>{` ${limits.map(m => m.compact).join(' ')}`}</Text> : <Text dimColor>{` ${short(u.tokens)}/${short(limit ?? u.window)}`}</Text>}
        {limits.length === 0 && u.usd !== undefined ? <Text dimColor>{` ${dollars(u.usd)}`}</Text> : null}
      </Box>
    )
  })






}
