// provider-models.test.ts — the gateway's model listing: where to ask, how
// to read the answer, what a PATCH may store.
import { describe, expect, it } from 'vitest'
import { MODELS_CAP, checkModelLimits, checkModels, gatewayModelFor, modelsUrlFor, parseModelsList, parseModelsListing } from '../src/provider-models.js'

describe('modelsUrlFor', () => {
  it('strips the Anthropic passthrough segment: cheapestinference serves /anthropic/v1/messages and /v1/models', () => {
    expect(modelsUrlFor('https://api.cheapestinference.com/anthropic')).toBe('https://api.cheapestinference.com/v1/models')
    expect(modelsUrlFor('https://api.cheapestinference.com/anthropic/')).toBe('https://api.cheapestinference.com/v1/models')
  })
  it('a proxy at the origin, or one mounted at /v1, lists at /v1/models too', () => {
    expect(modelsUrlFor('https://proxy.test')).toBe('https://proxy.test/v1/models')
    expect(modelsUrlFor('https://proxy.test/v1')).toBe('https://proxy.test/v1/models')
  })
  it('any other path is kept — the operator mounted it there', () => {
    expect(modelsUrlFor('https://gw.test/tenant-7')).toBe('https://gw.test/tenant-7/v1/models')
  })
})

describe('parseModelsList', () => {
  it('reads the OpenAI shape, keeps order, dedupes, drops non-string ids', () => {
    const body = { object: 'list', data: [{ id: 'kimi-k3' }, { id: 'qwen3.8-max' }, { id: 'kimi-k3' }, { id: 7 }, { name: 'x' }] }
    expect(parseModelsList(body)).toEqual(['kimi-k3', 'qwen3.8-max'])
  })
  it('accepts a bare array of ids and a { models: [...] } answer', () => {
    expect(parseModelsList(['a', 'b'])).toEqual(['a', 'b'])
    expect(parseModelsList({ models: ['glm-5.3', { id: 'minimax-m3' }] })).toEqual(['glm-5.3', 'minimax-m3'])
  })
  it('an unknown shape is an empty list, never a throw', () => {
    expect(parseModelsList(null)).toEqual([])
    expect(parseModelsList('nope')).toEqual([])
    expect(parseModelsList({ data: 'x' })).toEqual([])
  })
  it('drops empty, braced and oversize ids and caps the list', () => {
    const many = Array.from({ length: MODELS_CAP + 5 }, (_, i) => ({ id: `m${i}` }))
    expect(parseModelsList({ data: [{ id: ' ' }, { id: 'a{b}' }, { id: 'x'.repeat(101) }, ...many] })).toHaveLength(MODELS_CAP)
  })
})

describe('checkModels (PATCH models)', () => {
  it('returns the cleaned list', () => {
    expect(checkModels([' kimi-k3 ', 'glm-5.3', 'kimi-k3'])).toEqual(['kimi-k3', 'glm-5.3'])
    expect(checkModels([])).toEqual([])
  })
  it('refuses a non-array, non-string members, empty ids and braces — in plain English', () => {
    expect(() => checkModels('kimi-k3')).toThrow('array of model ids')
    expect(() => checkModels([1])).toThrow('array of model ids')
    expect(() => checkModels([''])).toThrow('empty id')
    expect(() => checkModels(['{env:X}'])).toThrow("'{'")
    expect(() => checkModels(['x'.repeat(101)])).toThrow('at most 100')
  })
})

describe('parseModelsListing — ids AND the limits the gateway publishes', () => {
  it('reads context_length (cheapestinference/OpenRouter) and the output conventions; unknown = absent', () => {
    const body = {
      data: [
        { id: 'mimo-v2.6-flash', context_length: 1048576 },
        { id: 'kimi-k3', max_context_length: 262144, max_output_tokens: 32000 },
        { id: 'glm-5.3', context_window: 1000000, top_provider: { max_completion_tokens: 16000 } },
        { id: 'bare' },
        { id: 'junk', context_length: -5 },
      ],
    }
    const l = parseModelsListing(body)
    expect(l.ids).toEqual(['mimo-v2.6-flash', 'kimi-k3', 'glm-5.3', 'bare', 'junk'])
    expect(l.limits).toEqual({
      'mimo-v2.6-flash': { context: 1048576 },
      'kimi-k3': { context: 262144, output: 32000 },
      'glm-5.3': { context: 1000000, output: 16000 },
    })
  })
  it('a bare id list has no limits; an unknown shape is empty', () => {
    expect(parseModelsListing(['a', 'b'])).toEqual({ ids: ['a', 'b'], limits: {} })
    expect(parseModelsListing(null)).toEqual({ ids: [], limits: {} })
  })
})

describe('gatewayModelFor — what a gateway run uses', () => {
  const models = ['mimo-v2.6-flash', 'deepseek-v4.1-flash']
  it('the pin when the key lists it; the FIRST model when the pin is gone or absent', () => {
    expect(gatewayModelFor(models, 'deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash')
    expect(gatewayModelFor(models, 'kimi-k3')).toBe('mimo-v2.6-flash')
    expect(gatewayModelFor(models, null)).toBe('mimo-v2.6-flash')
    expect(gatewayModelFor(models, '')).toBe('mimo-v2.6-flash')
  })
  it('with nothing known about the key, the pin stands (or nothing)', () => {
    expect(gatewayModelFor(undefined, 'kimi-k3')).toBe('kimi-k3')
    expect(gatewayModelFor([], null)).toBeNull()
  })
})

describe('checkModelLimits (PATCH modelLimits)', () => {
  it('accepts id → { context, output } with positive integers, refuses the rest in plain English', () => {
    expect(checkModelLimits({ 'kimi-k3': { context: 262144.7, output: 32000 } })).toEqual({ 'kimi-k3': { context: 262144, output: 32000 } })
    expect(() => checkModelLimits([])).toThrow('object of model id')
    expect(() => checkModelLimits({ '': { context: 1 } })).toThrow('invalid model id')
    expect(() => checkModelLimits({ a: { context: -1 } })).toThrow('positive integer')
    expect(() => checkModelLimits({ a: 'x' })).toThrow('must be { context, output }')
  })
})
