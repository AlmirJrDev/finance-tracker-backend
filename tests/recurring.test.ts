import { describe, expect, it } from 'vitest'
import { login, useTestApp, type Api } from './helpers'

const ctx = useTestApp()

async function createRecurring(api: Api, overrides: Record<string, unknown> = {}) {
  const res = await api.post('/api/recurring-transactions', {
    description: 'Aluguel',
    amountCents: 150_000,
    type: 'expense',
    frequency: 'monthly',
    dayOfMonth: 5,
    startDate: '2026-01-01',
    ...overrides,
  })
  if (res.status !== 201) throw new Error(`${res.status} ${JSON.stringify(res.body)}`)
  return res.body.data
}

describe('recorrências', () => {
  it('valida campos obrigatórios por frequência', async () => {
    const { api } = await login(ctx.app)
    const base = { description: 'Academia', amountCents: 9_990, type: 'expense', startDate: '2026-01-01' }

    const monthly = await api.post('/api/recurring-transactions', { ...base, frequency: 'monthly' }).expect(400)
    expect(monthly.body.message).toContain('dayOfMonth')
    await api.post('/api/recurring-transactions', { ...base, frequency: 'weekly' }).expect(400)
    await api
      .post('/api/recurring-transactions', { ...base, frequency: 'daily', endDate: '2025-12-01' })
      .expect(400)
  })

  it('aplicar é idempotente em qualquer ordem (bug do lastAppliedMonth)', async () => {
    const { api } = await login(ctx.app)
    await createRecurring(api)

    const oct = await api.post('/api/recurring-transactions/apply', { from: '2026-10', to: '2026-10' }).expect(200)
    expect(oct.body.data).toEqual({ created: 1, existing: 0 })
    await api.post('/api/recurring-transactions/apply', { from: '2026-09', to: '2026-09' }).expect(200)
    const again = await api.post('/api/recurring-transactions/apply', { from: '2026-09', to: '2026-10' }).expect(200)
    expect(again.body.data).toEqual({ created: 0, existing: 2 })

    const txs = (await api.get('/api/transactions?from=2026-09-01&to=2026-10-31')).body.data
    expect(txs.map((t: { date: string }) => t.date).sort()).toEqual(['2026-09-05', '2026-10-05'])
    expect(txs.every((t: { recurringId: string | null }) => t.recurringId)).toBe(true)
  })

  it('aplica vários meses de uma vez respeitando a data final e ignorando inativas', async () => {
    const { api } = await login(ctx.app)
    await createRecurring(api, { startDate: '2026-09-01', endDate: '2026-11-30' })
    await createRecurring(api, { description: 'Pausada', isActive: false })

    const res = await api.post('/api/recurring-transactions/apply', { from: '2026-09', to: '2027-08' }).expect(200)
    expect(res.body.data.created).toBe(3)

    await api.post('/api/recurring-transactions/apply', { from: '2026-01', to: '2028-12' }).expect(400)
  })

  it('semanal gera uma transação por semana', async () => {
    const { api } = await login(ctx.app)
    await createRecurring(api, { frequency: 'weekly', dayOfWeek: 1, dayOfMonth: null, amountCents: 2_000 })
    const res = await api.post('/api/recurring-transactions/apply', { from: '2026-09', to: '2026-09' }).expect(200)
    expect(res.body.data.created).toBe(4)
  })

  it('atualização parcial valida o resultado final', async () => {
    const { api } = await login(ctx.app)
    const item = await createRecurring(api)

    const paused = await api.put(`/api/recurring-transactions/${item.id}`, { isActive: false }).expect(200)
    expect(paused.body.data).toMatchObject({ isActive: false, dayOfMonth: 5, amountCents: 150_000 })

    // Mudar para semanal sem informar o dia da semana é inválido
    await api.put(`/api/recurring-transactions/${item.id}`, { frequency: 'weekly' }).expect(400)
    const weekly = await api
      .put(`/api/recurring-transactions/${item.id}`, { frequency: 'weekly', dayOfWeek: 3 })
      .expect(200)
    expect(weekly.body.data).toMatchObject({ frequency: 'weekly', dayOfWeek: 3, dayOfMonth: null })
  })
})
