// The one price table and costOf (pure). SPEC.md section 6. Per-agent costs are estimates: the
// session figure comes exact from `$.session.usage()`.

// Prices: USD per million tokens, from the claude-api skill bundled with Claude Code 2.1.296 (the
// skill's table cached 2026-10-06). Columns: input, output, cache read, cache write 5m, cache
// write 1h. Order matters: the first row whose regex matches wins, so the most specific family
// comes first (opus-5-5 before opus-5, fable-5-1 before fable-5). A model id the table does not
// name falls back to the sonnet-5-5 row (the current Sonnet) and is marked unknown (`est.?`).
// Shown after the agents sum on the Usage tab.
export const PRICES_NOTE = 'prices as of 2026-10-06'

export type Row = [input: number, output: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number]

// The trailing group ends a family at a digit boundary: opus-5 does not take opus-5-5 or opus-50.
const END = '(?![0-9])'

const TABLE: Array<[RegExp, Row]> = [
  [new RegExp('(?:fable|mythos)-5-1' + END), [10, 50, 0.25, 12.5, 20]],
  [new RegExp('(?:fable|mythos)-5' + END), [10, 50, 1.0, 12.5, 20]],
  [new RegExp('opus-5-5' + END), [4, 20, 0.2, 5, 8]],
  [new RegExp('opus-5' + END), [5, 25, 0.5, 6.25, 10]],
  [new RegExp('opus-4-[678]' + END), [5, 25, 0.5, 6.25, 10]],
  [new RegExp('sonnet-5-5' + END), [2, 10, 0.2, 2.5, 4]],
  [new RegExp('sonnet-5' + END), [2, 10, 0.2, 2.5, 4]],
  [new RegExp('sonnet-4-6' + END), [3, 15, 0.3, 3.75, 6]],
  [new RegExp('haiku-5-5' + END), [0.1, 0.5, 0.01, 0.125, 0.2]],
  [new RegExp('haiku-4-5' + END), [1, 5, 0.1, 1.25, 2]],
]

const FALLBACK: Row = [2, 10, 0.2, 2.5, 4]

// haiku-5-5: a step whose prompt exceeds 100K tokens is billed 0.50 input and 2.50 output.
const HAIKU_LONG = { family: new RegExp('haiku-5-5' + END), above: 100_000, input: 0.5, output: 2.5 }

// opus-5-5 in fast mode (`usage.speed === 'fast'`) costs twice the standard rate.
const FAST_DOUBLE = new RegExp('opus-5-5' + END)

export interface PriceUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null
  speed?: string | null
  model?: string
}

export interface Cost {
  usd: number
  known: boolean // the model id is a row of the table; false means the sonnet fallback (`est.?`)
  writeAssumed: boolean // cache writes had no 5m/1h split and were priced at the 1h rate
}

const rowOf = (model: string | undefined): Row | undefined => {
  const m = (model ?? '').toLowerCase()
  for (const [re, row] of TABLE) if (re.test(m)) return row
  return undefined
}

// The table's family for a model id, or undefined when the table has no row for it.
export function priceFamily(model: string | undefined): string | undefined {
  const m = (model ?? '').toLowerCase()
  for (const [re] of TABLE) {
    const hit = re.exec(m)
    if (hit) return hit[0]
  }
  return undefined
}

// One response's (or one turn's) cost. `usage.model`, the id the API answered with, is preferred to
// the caller's `model`. Cache writes use the 5m/1h split when the usage carries it; otherwise the
// whole write is priced at the 1h rate, the TTL these accounts run, and `writeAssumed` is set.
export function costOf(model: string | undefined, usage: PriceUsage): Cost {
  const id = usage.model ?? model
  const row = rowOf(id)
  const [pIn, pOut, pRead, p5m, p1h] = row ?? FALLBACK
  const n = (v: number | null | undefined) => (typeof v === 'number' && v > 0 ? v : 0)
  const input = n(usage.input_tokens)
  const read = n(usage.cache_read_input_tokens)
  const split = usage.cache_creation
  const w5m = split ? n(split.ephemeral_5m_input_tokens) : 0
  const w1h = split ? n(split.ephemeral_1h_input_tokens) : n(usage.cache_creation_input_tokens)
  const write = split ? w5m + w1h : w1h
  let rateIn = pIn
  let rateOut = pOut
  if (HAIKU_LONG.family.test((id ?? '').toLowerCase()) && input + read + write > HAIKU_LONG.above) {
    rateIn = HAIKU_LONG.input
    rateOut = HAIKU_LONG.output
  }
  let usd = (input * rateIn + n(usage.output_tokens) * rateOut + read * pRead + w5m * p5m + w1h * p1h) / 1_000_000
  if (usage.speed === 'fast' && FAST_DOUBLE.test((id ?? '').toLowerCase())) usd *= 2
  return { usd, known: row !== undefined, writeAssumed: !split && write > 0 }
}
