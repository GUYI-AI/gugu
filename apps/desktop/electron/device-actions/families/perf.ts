/**
 * 性能读数(perf.snapshot / perf.history / perf.capture):这台电脑上咕咕自己的资源监视器读数,给 agent 在咕咕外面读。
 * 和设置页「资源监视器」显示的是同一份记录、同一层投影(@shared/resource-monitor-public):只有数字和固定枚举,
 * ❌ 窗口 / 会话标题、pid、命令行、路径、消息内容。连上这一组就是同意采样:监视器没开时由这次读数按需拉起(reading.ts),
 * ❌ 再让人去开第二个开关;perf.capture 录几秒主窗口的 trace,同样不再另问。
 */
import { fail, ok, type ActionDef, type ActionFamily, type Args } from '../catalog'

const READING = 'cpuPercent (100 = one core), memoryBytes and memoryMetric (footprint = memory each process alone accounts for; rss = older sum that counts shared pages repeatedly), per-kind usage (app processes by type, services, sessions, terminals), page = the main window since the previous sample (longFrames >= 50 ms, blockingMs, slowInteractions >= 100 ms, styleLayoutMs, nodes, listeners), recent = page metrics summed over the last minute'

async function guarded(ctx: Parameters<ActionDef['run']>[1], read: (perf: NonNullable<typeof ctx.deps.perf>) => Promise<unknown> | unknown) {
  const perf = ctx.deps.perf
  if (!perf) return fail('unsupported', 'This computer has no resource monitor.')
  try { return ok(await read(perf)) }
  catch (error) { return fail('execution_failed', error instanceof Error ? error.message : String(error)) }
}

const num = (args: Args, key: string) => (typeof args[key] === 'number' && Number.isFinite(args[key]) ? (args[key] as number) : undefined)

const snapshot: ActionDef = {
  name: 'perf.snapshot',
  group: 'perf',
  title: '读取性能读数',
  titleEn: 'Read performance',
  description: `The last recorded resource-monitor sample of 咕咕 on this computer (at most ~10 s old; when the monitor is off, this starts it for 15 minutes and returns its first sample): ${READING}. Stalls the user feels show in page.longFrames / page.slowInteractions / page.styleLayoutMs; CPU only says the app is busy.`,
  risk: 'low',
  confirm: 'never',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  run: (_args, ctx) => guarded(ctx, (perf) => perf.snapshot()),
}

const history: ActionDef = {
  name: 'perf.history',
  group: 'perf',
  title: '读取性能历史',
  titleEn: 'Read performance history',
  description: 'Recorded resource-monitor points between since and until (epoch milliseconds; default the last hour; at most 24 h; about 300 points, keeping each stretch\'s peaks): timestamp, cpu, memory, longFrames, slowInteractions, styleLayoutMs, pageIntervalMs. Use it for growth over time ("slower the longer it runs"). Only sampled stretches have points: `note` says from when it has records.',
  risk: 'low',
  confirm: 'never',
  input_schema: {
    type: 'object',
    properties: { since: { type: 'number', description: 'epoch ms' }, until: { type: 'number', description: 'epoch ms' } },
    additionalProperties: false,
  },
  validate: (args) => (args.since !== undefined && num(args, 'since') === undefined) || (args.until !== undefined && num(args, 'until') === undefined) ? 'since and until must be epoch milliseconds' : null,
  run: (args, ctx) => guarded(ctx, (perf) => {
    const until = num(args, 'until') ?? Date.now()
    return perf.history(num(args, 'since') ?? until - 3_600_000, until)
  }),
}

const capture: ActionDef = {
  name: 'perf.capture',
  group: 'perf',
  title: '录一段性能记录',
  titleEn: 'Record performance',
  description: 'Record the main window\'s timeline for `seconds` (1-15, default 10) while something happens, then return its long tasks (>= 50 ms): ms, styleMs, styleElements (elements one style pass touched), layoutMs, scriptMs and the app functions the script time sampled into. Recording adds overhead while it runs; one recording at a time.',
  risk: 'low',
  confirm: 'never',
  input_schema: { type: 'object', properties: { seconds: { type: 'number', minimum: 1, maximum: 15 } }, additionalProperties: false },
  validate: (args) => (args.seconds === undefined || ((num(args, 'seconds') ?? 0) >= 1 && (num(args, 'seconds') ?? 99) <= 15) ? null : 'seconds must be between 1 and 15'),
  async run(args, ctx) {
    ctx.note('正在录…')
    return guarded(ctx, (perf) => perf.capture(num(args, 'seconds') ?? 10))
  },
}

export function createPerfFamily(): ActionFamily {
  return {
    groups: [{ id: 'perf', platforms: ['darwin', 'win32', 'linux'] }],
    actions: [snapshot, history, capture],
  }
}
