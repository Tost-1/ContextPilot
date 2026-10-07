import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { accountOf, checkpointPrompt, fill, meters, money, parseTarget, respond, resumePrompt, short, step } from '../hooks/register'

const CWD = '/repo/AnyProject'
const PATH = `${CWD}/.context-pilot/CHECKPOINT.md`
const DOCS = `${CWD}/docs/CHECKPOINT.md`

type World = { tokens: number | undefined; commands: string[]; prompts: string[]; content: string | null; skipWrite: boolean; files: string[]; written: string[]; rateLimits: object[]; report: object | null }

function markOf(text: string) {
  return text.match(/<!-- context-pilot (\S+) -->/)![1]!
}

function prompted(text: string | undefined, handoff: 'full' | 'lean', path: string, isProject: boolean) {
  return text === checkpointPrompt(310_000, handoff, path, isProject, markOf(text ?? '<!-- context-pilot x -->'))
}

let enableOnStart = false
let pending: string | null = null
let turns = 0

function world(on: On, settings: object) {
  const w: World = { tokens: undefined, commands: [], prompts: [], content: null, skipWrite: false, files: [], written: [], rateLimits: [], report: null }
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on, { settings })
  enableOnStart = (settings as { isEnabled?: boolean }).isEnabled === true
  pending = null
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: undefined }) as never)
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('process.run', (_$, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'git' ? `${CWD}\n` : 'claude', stderr: '' } }) as never)
  on('fs.exists', (_$, e) => ({ value: w.files.includes(e.path) }) as never)
  on('fs.write', (_$, e) => {
    w.written.push(`${e.path}=${e.text}`)
    return { value: undefined } as never
  })
  on('settings.read', () => ({ value: {} }) as never)
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{`hint ${e.props.hint}`}</Text>
  })
  on('ui.focus', () => ({}))
  on('session.cwd', () => ({ value: CWD }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: w.tokens, percent: w.tokens === undefined ? undefined : Math.round(w.tokens / 10_000) }, rateLimits: w.rateLimits, cost: { usd: 2.0712 } } }) as never)
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }) as never)
  on('http.fetch', () => ({ value: w.report ? { status: 200, ok: true, headers: {}, text: JSON.stringify(w.report) } : { status: 500, ok: false, headers: {}, text: '' } }) as never)
  on('command.register', (_$, e) => ({ value: { command: e.name } }) as never)
  on('command.run', (_$, e) => {
    w.commands.push(`/${e.command}${e.args ? ` ${e.args}` : ''}`)
    return {}
  })
  on('prompt.submit', (_$, e) => {
    w.prompts.push(e.text)
    pending = e.text
    if (e.text.startsWith('Context pilot: context is at') && !w.skipWrite) w.content = `<!-- context-pilot ${markOf(e.text)} -->`
    return { text: e.text } as never
  })
  on('fs.read', (_$, e) => {
    if (w.content === null || ![PATH, DOCS].includes(e.path)) throw new Error('ENOENT')
    return { value: w.content } as never
  })
  return { w, clock }
}

async function turn($: Engine, clock: { settle: () => Promise<void> }, extra: object = {}, text = pending ?? 'hi') {
  pending = null
  const turnId = `t${++turns}`
  await $.turn.start({ text, turnId } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId, reason: 'answer', ...extra } as never)
  await clock.settle()
}

function pilot($: Engine, args: string) {
  return $.command.run({ command: 'ctx', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
}

async function start($: Engine) {
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true } as never)
  if (enableOnStart) await pilot($, 'on')
}

describe('context-pilot', () => {
  test('helpers', () => {
    expect([fill(0, 8), fill(2, 8), fill(9, 8), fill(62, 8), fill(150, 8)]).toEqual([0, 1, 1, 5, 8])
    expect(short(300_000)).toBe('300k')
    expect(parseTarget('300k')).toBe(300_000)
    expect(parseTarget('1.5m')).toBe(1_500_000)
    expect(parseTarget('nope')).toBe(null)
    expect(checkpointPrompt(310_000, 'full', PATH, false, 'm1')).toContain('## The task')
    expect(checkpointPrompt(310_000, 'lean', PATH, false, 'm1')).not.toContain('## The task')
    expect(checkpointPrompt(310_000, 'lean', PATH, false, 'm1')).toContain('## In flight — the respawn table')
    expect(step(300_000, [250_000, 300_000, 400_000], 1)).toBe(400_000)
    expect(step(300_000, [250_000, 300_000, 400_000], -1)).toBe(250_000)
    expect(step(400_000, [250_000, 300_000, 400_000], 1)).toBe(400_000)
    expect(step(320_000, [250_000, 300_000, 400_000], -1)).toBe(300_000)
  })

  test('checkpoints, clears and resumes at the target', async ($, on) => {
    const { w, clock } = world(on, { isEnabled: true, target: 300_000 })
    await start($)
    w.tokens = 120_000
    await turn($, clock)
    expect(w.prompts).toEqual([])
    w.tokens = 310_000
    await turn($, clock)
    expect(w.prompts.length).toBe(1)
    expect(prompted(w.prompts[0], 'full', PATH, false)).toBe(true)
    await turn($, clock)
    expect(w.commands).toEqual(['/clear'])
    expect(w.prompts.at(-1)).toBe(resumePrompt(PATH))
    w.tokens = 40_000
    await turn($, clock)
    expect(w.prompts.length).toBe(2)
  })

  test('uses the lean handoff when set', async ($, on) => {
    const { w, clock } = world(on, { isEnabled: true, target: 300_000, handoff: 'lean' })
    await start($)
    w.tokens = 310_000
    await turn($, clock)
    expect(prompted(w.prompts[0], 'lean', PATH, false)).toBe(true)
  })

  test('does nothing when off, for subagents or aborted turns', async ($, on) => {
    const { w, clock } = world(on, { isEnabled: false, target: 300_000 })
    await start($)
    w.tokens = 500_000
    await turn($, clock)
    await pilot($, 'on')
    await turn($, clock, { agentId: 'a1' })
    await turn($, clock, { isAborted: true, reason: 'aborted' })
    expect(w.prompts).toEqual([])
  })

  test('never clears when the checkpoint was not written or belongs to another session', async ($, on) => {
    const { w, clock } = world(on, { isEnabled: true, target: 300_000 })
    await start($)
    w.tokens = 310_000
    w.skipWrite = true
    await turn($, clock)
    await turn($, clock)
    expect(w.commands).toEqual([])
    w.content = '<!-- context-pilot someone-else -->'
    await turn($, clock)
    await turn($, clock)
    expect(w.commands).toEqual([])
  })

  test('turns itself off only after two resumes in a row end over the target', async ($, on) => {
    const { w, clock } = world(on, { isEnabled: true, target: 300_000 })
    await start($)
    w.tokens = 310_000
    await turn($, clock)
    await turn($, clock)
    await turn($, clock)
    expect(w.commands).toEqual(['/clear'])
    expect(w.prompts.length).toBe(3)
    await turn($, clock)
    await turn($, clock)
    expect(w.commands).toEqual(['/clear', '/clear'])
    await turn($, clock)
    expect(w.prompts.length).toBe(4)
    expect((await pilot($, '')).text).toMatch(/^Context pilot off/)
  })

  test('/ctx draws the picker under the prompt', async ($, on) => {
    const { w } = world(on, { isEnabled: false, target: 300_000 })
    await start($)
    w.tokens = 10_000
    await pilot($, '')
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'context-pilot', surface, component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never)
      expect(await ui.find({ type: 'Text', text: 'Context target' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'At 300k: writes a checkpoint (full) → /clear → resumes from it' })).toBeDefined()
      await ui.unmount()
    }
  })

  test('picker keys', () => {
    const draft = { isEnabled: false, target: 300_000, handoff: 'full' } as const
    const stops = [250_000, 300_000, 400_000]
    expect(respond('.', draft, stops)).toEqual({ target: 400_000 })
    expect(respond(']', draft, stops)).toEqual({ target: 400_000 })
    expect(respond(',', draft, stops)).toEqual({ target: 250_000 })
    expect(respond('[', draft, stops)).toEqual({ target: 250_000 })
    expect(respond('left', draft, stops)).toBe(null)
    expect(respond(';', draft, stops)).toEqual({ isEnabled: true })
    expect(respond("'", draft, stops)).toEqual({ handoff: 'lean' })
    expect(respond('t', draft, stops)).toBe(null)
    expect(respond('h', draft, stops)).toBe(null)
    expect(respond('x', draft, stops)).toBe(null)
    expect(respond(undefined, draft, stops)).toBe(null)
  })

  test('a submit closes the picker and the hint comes back', async ($, on) => {
    world(on, { isEnabled: false, target: 300_000 })
    await start($)
    await pilot($, '')
    await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } } as never)
    const ui = await $.ui.mount({ plugin: 'context-pilot', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never)
    expect(await ui.find({ type: 'Text', text: 'Context target' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
  })

  test('arguments switch it on, off and set the target', async ($, on) => {
    world(on, { isEnabled: false, target: 300_000 })
    await start($)
    await pilot($, '250k')
    expect((await pilot($, 'on')).text).toBe('Context pilot on · 250k.')
    expect((await pilot($, 'x')).text).toMatch(/^Usage/)
  })

  test('desktop /ctx row is a clickable picker', async ($, on) => {
    world(on, { isEnabled: false, target: 300_000 })
    on('ui.render', { component: 'CommandOutput' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>{e.props.text}</Text>
    })
    await start($)
    const out = await pilot($, '')
    expect(out.text).toBe('Context pilot off · target 300k · full handoff')
    const props = { command: 'ctx', args: '', text: out.text, isErrored: false }
    const ui = await $.ui.mount({ plugin: 'context-pilot', surface: 'desktop', component: 'CommandOutput', props } as never)
    await ui.press({ key: 'stop:400000' } as never)
    await ui.press({ key: 'toggle' } as never)
    await ui.press({ key: 'handoff' } as never)
    expect(await ui.find({ type: 'Text', text: 'At 400k: writes a checkpoint (lean) → /clear → resumes from it' })).toBeDefined()
    expect((await pilot($, 'on')).text).toBe('Context pilot on · 400k.')
    const term = await $.ui.mount({ plugin: 'context-pilot', surface: 'terminal', component: 'CommandOutput', props } as never)
    expect(await term.find({ type: 'Text', text: 'Context pilot off · target 300k · full handoff' })).toBeDefined()
  })

  for (const [settings, tokens, percent, figures] of [
    [{ isEnabled: true, target: 300_000 }, 186_000, ' 62%', ' · 186k / 300k target'],
    [{ isEnabled: false, target: 300_000 }, 186_000, ' 19%', ' · 186k / 1M'],
  ] as const) {
    test(`bar shows${percent}${figures}`, async ($, on) => {
      const { w } = world(on, settings)
      w.tokens = tokens
      await start($)
      const ui = await $.ui.mount({ plugin: 'context-pilot', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never)
      expect(await ui.find({ type: 'Text', text: percent })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: figures })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: ' · $2.07' })).toBeDefined()
    })
  }

  test('limits and monthly spend', () => {
    expect(money(1500)).toBe('$1,500')
    expect(money(412.4)).toBe('$412')
    const minor = (amount_minor: number) => ({ amount_minor, currency: 'USD', exponent: 2 })
    expect(accountOf({ spend: { used: minor(41_237), limit: minor(150_000) } }).spend).toEqual({ used: 412.37, limit: 1500 })
    expect(accountOf({ extra_usage: { is_enabled: true, monthly_limit: 150_000, used_credits: 41_237 } }).spend).toEqual({ used: 412.37, limit: 1500 })
    expect(accountOf({ wattle_ember: { limit_dollars: 1500, used_dollars: 412.37 } }).spend).toEqual({ used: 412.37, limit: 1500 })
    expect(accountOf({ spend: { used: minor(0), limit: null }, extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null } }).spend).toBe(undefined)
    const usage = { percent: 10, tokens: 1, window: 10 }
    const spend = { used: 412.37, limit: 1500 }
    expect(meters({ ...usage, fiveHour: 34, week: 61 }, { spend }).map(m => m.compact)).toEqual(['5h 34%', 'wk 61%'])
    expect(meters(usage, { fiveHour: 0, week: 0, spend }).map(m => m.text)).toEqual(['27% ($412 / $1,500)'])
    expect(meters(usage, { fiveHour: 5 }).map(m => m.text)).toEqual(['5%', '0%'])
    expect(meters({ ...usage, week: 49 }, { fiveHour: 2, week: 50 }).map(m => m.compact)).toEqual(['5h 2%', 'wk 49%'])
    expect(meters({ ...usage, week: 49 }, null).map(m => m.compact)).toEqual(['5h 0%', 'wk 49%'])
    expect(meters(usage, { spend }).map(m => [m.text, m.compact])).toEqual([['27% ($412 / $1,500)', '$412/$1.5k']])
    expect(meters(usage, null)).toEqual([])
  })

  test('bar shows the 5-hour and weekly limits on a subscription', async ($, on) => {
    const { w, clock } = world(on, { isEnabled: false, target: 300_000 })
    w.tokens = 186_000
    w.rateLimits = [{ kind: 'five_hour', percentUsed: 34 }, { kind: 'seven_day', percentUsed: 91.5 }]
    w.report = { spend: { used: { amount_minor: 41_237, exponent: 2 }, limit: { amount_minor: 150_000, exponent: 2 } } }
    await start($)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'context-pilot', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never)
    expect(await ui.find({ type: 'Text', text: ' · 5h ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '34%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · week ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '92%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · month ' })).toBeUndefined()
  })

  test('bar shows monthly spend where there are no limits', async ($, on) => {
    const { w, clock } = world(on, { isEnabled: false, target: 300_000 })
    w.tokens = 186_000
    w.report = { five_hour: null, seven_day: null, spend: { used: { amount_minor: 41_237, exponent: 2 }, limit: { amount_minor: 150_000, exponent: 2 } } }
    await start($)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'context-pilot', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never)
    expect(await ui.find({ type: 'Text', text: ' · $2.07' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · month ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '27% ($412 / $1,500)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · 5h ' })).toBeUndefined()
    const desk = await $.ui.mount({ plugin: 'context-pilot', surface: 'desktop', component: 'SessionMode', props: { modes: ['focus'] } } as never)
    expect(await desk.find({ type: 'Text', text: ' $412/$1.5k' })).toBeDefined()
  })

  for (const source of ['resume', 'clear'] as const) {
    test(`bar keeps the target after a ${source}`, async ($, on) => {
      const { w } = world(on, { isEnabled: true, target: 300_000 })
      on('classic.SessionStart', () => ({}) as never)
      w.tokens = 186_000
      await start($)
      await $.classic.SessionStart({ source } as never)
      const ui = await $.ui.mount({ plugin: 'context-pilot', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never)
      expect(await ui.find({ type: 'Text', text: ' · 186k / 300k target' })).toBeDefined()
    })
  }

  test('bar shows the resumed transcript before the first reply', async ($, on) => {
    world(on, { isEnabled: true, target: 300_000 })
    on('classic.SessionStart', () => ({}) as never)
    await start($)
    await $.classic.SessionStart({ source: 'resume', context_tokens: 186_000 } as never)
    const ui = await $.ui.mount({ plugin: 'context-pilot', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never)
    expect(await ui.find({ type: 'Text', text: ' · 186k / 300k target' })).toBeDefined()
    await $.classic.SessionStart({ source: 'clear' } as never)
    expect(await ui.find({ type: 'Text', text: ' · 186k / 300k target' })).toBeUndefined()
  })

  test('bar catches up once a resumed conversation has loaded', async ($, on) => {
    const { w, clock } = world(on, { isEnabled: true, target: 300_000 })
    on('classic.SessionStart', () => ({}) as never)
    await start($)
    await $.classic.SessionStart({ source: 'resume' } as never)
    const ui = await $.ui.mount({ plugin: 'context-pilot', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never)
    expect(await ui.find({ type: 'Text', text: ' · 166k / 300k target' })).toBeUndefined()
    w.tokens = 166_000
    await clock.advance(500)
    expect(await ui.find({ type: 'Text', text: ' · 166k / 300k target' })).toBeDefined()
  })

  test('bar recovers after a resume even when SessionStart never reaches the mod', async ($, on) => {
    const { w, clock } = world(on, { isEnabled: true, target: 300_000 })
    on('session.end', (_$, e) => ({ sessionId: e.sessionId }) as never)
    await start($)
    await clock.advance(5_000)
    const ui = await $.ui.mount({ plugin: 'context-pilot', surface: 'terminal', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never)
    await $.session.end({ reason: 'resume', sessionId: 's1', resume: {} } as never)
    w.tokens = 166_000
    await clock.advance(500)
    expect(await ui.find({ type: 'Text', text: ' · 166k / 300k target' })).toBeDefined()
  })

  test('desktop shows context beside the footer modes', async ($, on) => {
    const { w } = world(on, { isEnabled: true, target: 300_000 })
    on('ui.render', { component: 'SessionMode' }, ($, e) => {
      const { Text } = $.ui.resolve(e)
      return <Text>{e.props.modes.join(' & ')}</Text>
    })
    w.tokens = 186_000
    await start($)
    const ui = await $.ui.mount({ plugin: 'context-pilot', surface: 'desktop', component: 'SessionMode', props: { modes: ['focus'] } } as never)
    expect(await ui.find({ type: 'Text', text: '━━━' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' $2.07' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 62%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 186k/300k' })).toBeDefined()
  })

  test('turning it on elsewhere does not turn it on in a new session', async ($, on) => {
    const { w, clock } = world(on, { isEnabled: true, target: 300_000, handoff: 'full' })
    enableOnStart = false
    await start($)
    w.tokens = 500_000
    await turn($, clock)
    expect(w.prompts).toEqual([])
  })

  test('without a lead setup it writes a gitignored .context-pilot checkpoint', async ($, on) => {
    const { w, clock } = world(on, { isEnabled: true, target: 300_000 })
    await start($)
    w.tokens = 310_000
    await turn($, clock)
    expect(w.written).toEqual([`${CWD}/.context-pilot/.gitignore=*\n`])
    expect(w.prompts[0]).toContain(`Write \`${PATH}\``)
    expect(w.prompts[0]).toContain('Do not commit it')
  })

  test('with a lead setup it uses docs/CHECKPOINT.md and commits', async ($, on) => {
    const { w, clock } = world(on, { isEnabled: true, target: 300_000 })
    w.files.push(`${CWD}/docs/STATUS.md`)
    await start($)
    w.tokens = 310_000
    await turn($, clock)
    expect(w.written).toEqual([])
    expect(prompted(w.prompts[0], 'full', DOCS, true)).toBe(true)
    expect(w.prompts[0]).toContain('git commit')
    await turn($, clock)
    expect(w.commands).toEqual(['/clear'])
    expect(w.prompts.at(-1)).toBe(resumePrompt(DOCS))
  })

  test('a report that starts a turn after the checkpoint stops the clear and re-checkpoints', async ($, on) => {
    const { w, clock } = world(on, { isEnabled: true, target: 300_000 })
    await start($)
    w.tokens = 310_000
    await turn($, clock)
    const ours = pending!
    pending = null
    await $.turn.start({ text: ours, turnId: 'cp' } as never)
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'cp', reason: 'answer' } as never)
    await $.turn.start({ text: 'agent-a finished: found the bug', turnId: 'report' } as never)
    await clock.settle()
    expect(w.commands).toEqual([])
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'report', reason: 'answer' } as never)
    await clock.settle()
    expect(w.prompts.length).toBe(2)
    expect(w.commands).toEqual([])
    await turn($, clock)
    expect(w.commands).toEqual(['/clear'])
  })

  test('a different turn before the checkpoint turn is not mistaken for it', async ($, on) => {
    const { w, clock } = world(on, { isEnabled: true, target: 300_000 })
    await start($)
    w.tokens = 310_000
    await turn($, clock)
    const ours = pending
    await turn($, clock, {}, 'a message the user typed')
    expect(w.commands).toEqual([])
    expect(w.prompts.length).toBe(1)
    await turn($, clock, {}, ours!)
    expect(w.commands).toEqual(['/clear'])
  })

  test('stopping the checkpoint turns it off for the session', async ($, on) => {
    const { w, clock } = world(on, { isEnabled: true, target: 300_000 })
    await start($)
    w.tokens = 310_000
    await turn($, clock)
    await turn($, clock, { isAborted: true, reason: 'aborted' })
    await turn($, clock)
    expect(w.commands).toEqual([])
    expect(w.prompts.length).toBe(1)
    expect((await pilot($, '')).text).toMatch(/^Context pilot off/)
  })

  test('a report delivered into the checkpoint turn stops the clear and re-checkpoints', async ($, on) => {
    const { w, clock } = world(on, { isEnabled: true, target: 300_000 })
    await start($)
    w.tokens = 310_000
    await turn($, clock)
    const ours = pending!
    pending = null
    await $.turn.start({ text: ours, turnId: 'cp' } as never)
    await $.prompt.submit({ text: 'agent-b finished', turnId: 'cp', wait: false, origin: { kind: 'composer' } } as never)
    pending = null
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'cp', reason: 'answer' } as never)
    await clock.settle()
    expect(w.commands).toEqual([])
    expect(prompted(w.prompts.at(-1), 'full', PATH, false)).toBe(true)
    await turn($, clock)
    expect(w.commands).toEqual(['/clear'])
  })

  test('turning it off during the checkpoint stops the clear', async ($, on) => {
    const { w, clock } = world(on, { isEnabled: true, target: 300_000 })
    await start($)
    w.tokens = 310_000
    await turn($, clock)
    const ours = pending!
    pending = null
    await $.turn.start({ text: ours, turnId: 'cp' } as never)
    await pilot($, 'off')
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'cp', reason: 'answer' } as never)
    await clock.settle()
    expect(w.commands).toEqual([])
  })

  test('warns when the target is beyond the context window', async ($, on) => {
    world(on, { isEnabled: false, target: 300_000 })
    await start($)
    expect((await pilot($, '1.5m')).text).toContain('never reached')
    expect((await pilot($, '300k')).text).not.toContain('never reached')
  })
})
