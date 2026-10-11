import { expect, test } from 'claude-code/testing'
import { costOf, priceFamily } from '../hooks/prices.ts'

const M = 1_000_000
// the kit has no toBeCloseTo: equal to nine decimals
const close = (actual: number, expected: number) => expect(actual.toFixed(9)).toBe(expected.toFixed(9))
// every counter at one million tokens, so each price in USD per million is the dollar cost of its column
const ONE_EACH = { input_tokens: M, output_tokens: M, cache_read_input_tokens: M, cache_creation_input_tokens: M }

test('opus-5-5: input 4, output 20, cache read 0.20; a write without a TTL split is priced at 1h and flagged', async () => {
  const c = costOf('claude-opus-5-5', ONE_EACH)
  close(c.usd, 4 + 20 + 0.2 + 8)
  expect(c.known).toBe(true)
  expect(c.writeAssumed).toBe(true)
})

test('a cache_creation split prices 5m and 1h each at their own rate and is not flagged', async () => {
  const c = costOf('claude-opus-5-5', { ...ONE_EACH, cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: M } })
  close(c.usd, 4 + 20 + 0.2 + 5 + 8)
  expect(c.writeAssumed).toBe(false)
})

test('the split wins over the aggregate; a null or missing counter is zero', async () => {
  const c = costOf('claude-sonnet-4-6', {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: 999,
    cache_creation: { ephemeral_5m_input_tokens: M, ephemeral_1h_input_tokens: 0 },
  })
  close(c.usd, 3.75)
  expect(costOf('claude-sonnet-4-6', {}).usd).toBe(0)
})

// every row of the table: [model id, input, output, cache read, write 5m, write 1h]
const ROWS: Array<[string, number, number, number, number, number]> = [
  ['claude-fable-5-1', 10, 50, 0.25, 12.5, 20],
  ['claude-mythos-5-1', 10, 50, 0.25, 12.5, 20],
  ['claude-fable-5', 10, 50, 1.0, 12.5, 20],
  ['claude-mythos-5', 10, 50, 1.0, 12.5, 20],
  ['claude-opus-5-5', 4, 20, 0.2, 5, 8],
  ['claude-opus-5', 5, 25, 0.5, 6.25, 10],
  ['claude-opus-4-6', 5, 25, 0.5, 6.25, 10],
  ['claude-opus-4-7-20261001', 5, 25, 0.5, 6.25, 10],
  ['claude-opus-4-8', 5, 25, 0.5, 6.25, 10],
  ['claude-sonnet-5-5', 2, 10, 0.2, 2.5, 4],
  ['claude-sonnet-5', 2, 10, 0.2, 2.5, 4],
  ['claude-sonnet-4-6', 3, 15, 0.3, 3.75, 6],
  ['claude-haiku-5-5', 0.1, 0.5, 0.01, 0.125, 0.2],
  ['claude-haiku-4-5-20251001', 1, 5, 0.1, 1.25, 2],
]

test('every price row, most specific first (opus-5-5 before opus-5, fable-5-1 before fable-5)', async () => {
  for (const [model, input, output, read, w5, w1] of ROWS) {
    // haiku-5-5 is measured at 100K tokens, the top of its standard tier
    const u = model.indexOf('haiku-5-5') >= 0 ? 100_000 : M
    const at = (usage: Record<string, unknown>) => costOf(model, usage).usd
    close(at({ input_tokens: u }), (input * u) / M)
    close(at({ output_tokens: u }), (output * u) / M)
    close(at({ cache_read_input_tokens: u }), (read * u) / M)
    close(at({ cache_creation: { ephemeral_5m_input_tokens: u } }), (w5 * u) / M)
    close(at({ cache_creation: { ephemeral_1h_input_tokens: u } }), (w1 * u) / M)
    expect(costOf(model, {}).known).toBe(true)
  }
})

test('haiku-5-5 above 100K prompt tokens in a step is 0.50 input and 2.50 output; at 100K it is not', async () => {
  const small = costOf('claude-haiku-5-5', { input_tokens: 50_000, output_tokens: 10_000 })
  close(small.usd, 50_000 * 0.1 / M + 10_000 * 0.5 / M)
  const edge = costOf('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 10_000 })
  close(edge.usd, 100_000 * 0.1 / M + 10_000 * 0.5 / M)
  const big = costOf('claude-haiku-5-5', { input_tokens: 150_000, output_tokens: 10_000 })
  close(big.usd, 150_000 * 0.5 / M + 10_000 * 2.5 / M)
  // the prompt is input plus cache read plus cache write; the cache columns keep their own rate
  const cached = costOf('claude-haiku-5-5', { input_tokens: 1000, cache_read_input_tokens: 120_000, output_tokens: 0 })
  close(cached.usd, 1000 * 0.5 / M + 120_000 * 0.01 / M)
})

test('fast mode doubles opus-5-5 and nothing else', async () => {
  const base = costOf('claude-opus-5-5', ONE_EACH).usd
  close(costOf('claude-opus-5-5', { ...ONE_EACH, speed: 'fast' }).usd, base * 2)
  close(costOf('claude-opus-5-5', { ...ONE_EACH, speed: 'standard' }).usd, base)
  close(costOf('claude-opus-5-5', { ...ONE_EACH, speed: null }).usd, base)
  const sonnet = costOf('claude-sonnet-4-6', ONE_EACH).usd
  close(costOf('claude-sonnet-4-6', { ...ONE_EACH, speed: 'fast' }).usd, sonnet)
})

test('an unknown family uses the sonnet row and says so; a family in the table is known', async () => {
  const unknown = costOf('claude-newthing-9', { input_tokens: M, output_tokens: M })
  close(unknown.usd, 2 + 10)
  expect(unknown.known).toBe(false)
  expect(costOf(undefined, { input_tokens: M }).known).toBe(false)
  // a bare alias carries no version and cannot be priced from the table
  expect(costOf('opus', { input_tokens: M }).known).toBe(false)
  // opus-4-5 is not a row of the table
  expect(priceFamily('claude-opus-4-5')).toBe(undefined)
  expect(priceFamily('claude-opus-50')).toBe(undefined)
})

test('the model on the usage is the API id that answered and wins over the caller\'s', async () => {
  close(costOf(undefined, { input_tokens: M, model: 'claude-opus-5-5' }).usd, 4)
  close(costOf('opus', { input_tokens: M, model: 'claude-opus-5-5' }).usd, 4)
  close(costOf('claude-sonnet-5-5', { input_tokens: M, model: 'claude-opus-5-5' }).usd, 4)
})
