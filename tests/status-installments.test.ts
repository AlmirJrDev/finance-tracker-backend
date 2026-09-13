import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTx, login, useTestApp } from './helpers'

const ctx = useTestApp()

// "Hoje" fixo em 15/09/2026 (só o relógio é simulado; timers do driver continuam reais)
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-15T15:00:00Z'))
})
afterAll(() => {
  vi.useRealTimers()
})

describe('status pago/pendente', () => {
  it('assume pendente para datas futuras e pago para hoje/passado', async () => {
    const { api } = await login(ctx.app)
    expect((await createTx(api, { date: '2026-09-15' })).status).toBe('paid')
    expect((await createTx(api, { date: '2026-09-20' })).status).toBe('pending')
    expect((await createTx(api, { date: '2026-09-01', status: 'pending' })).status).toBe('pending')
  })

  it('filtra por status e altera em lote', async () => {
    const { api } = await login(ctx.app)
    const a = await createTx(api, { date: '2026-09-20' })
    const b = await createTx(api, { date: '2026-09-21' })
    await createTx(api, { date: '2026-09-10' })

    const pending = await api.get('/api/transactions?status=pending').expect(200)
    expect(pending.body.data).toHaveLength(2)

    const res = await api.post('/api/transactions/status', { ids: [a.id, b.id], status: 'paid' }).expect(200)
    expect(res.body.data.modifiedCount).toBe(2)
    expect((await api.get('/api/transactions?status=paid')).body.data).toHaveLength(3)
  })

  it('resumo separa pago e pendente', async () => {
    const { api } = await login(ctx.app)
    await createTx(api, { date: '2026-09-05', type: 'income', amountCents: 500_000 })
    await createTx(api, { date: '2026-09-10', amountCents: 100_000 })
    await createTx(api, { date: '2026-09-25', amountCents: 150_000 }) // pendente

    const s = (await api.get('/api/summary/month/2026-09')).body.data
    expect(s).toMatchObject({
      incomeCents: 500_000,
      expenseCents: 250_000,
      paidExpenseCents: 100_000,
      pendingExpenseCents: 150_000,
      pendingCount: 1,
      finalBalanceCents: 250_000,
      paidFinalBalanceCents: 400_000,
    })
    expect(s.byCategory[0].pendingExpenseCents).toBe(150_000)
  })
})

describe('parcelamento', () => {
  it('divide o valor, joga o resto na 1ª parcela e ajusta fim de mês', async () => {
    const { api } = await login(ctx.app)
    const res = await api
      .post('/api/transactions/installments', {
        date: '2026-08-31',
        description: 'Notebook',
        totalAmountCents: 100_000,
        installments: 3,
      })
      .expect(201)

    const items = res.body.data
    expect(items.map((t: { amountCents: number }) => t.amountCents)).toEqual([33_334, 33_333, 33_333])
    expect(items.map((t: { date: string }) => t.date)).toEqual(['2026-08-31', '2026-09-30', '2026-10-31'])
    expect(items.map((t: { status: string }) => t.status)).toEqual(['paid', 'pending', 'pending'])
    expect(items[1].installment).toMatchObject({ number: 2, total: 3, groupId: items[0].installment.groupId })
  })

  it('cancela só as parcelas pendentes', async () => {
    const { api } = await login(ctx.app)
    const items = (
      await api.post('/api/transactions/installments', {
        date: '2026-07-10',
        description: 'Geladeira',
        totalAmountCents: 240_000,
        installments: 6,
      })
    ).body.data
    const groupId = items[0].installment.groupId

    const del = await api.delete(`/api/transactions/installments/${groupId}?onlyPending=true`).expect(200)
    // Pagas: jul, ago, set (10/09 já passou). Pendentes removidas: out, nov, dez
    expect(del.body.data.deletedCount).toBe(3)
    expect((await api.get('/api/transactions')).body.data.map((t: { date: string }) => t.date).sort()).toEqual([
      '2026-07-10',
      '2026-08-10',
      '2026-09-10',
    ])
  })

  it('valida o número de parcelas', async () => {
    const { api } = await login(ctx.app)
    const base = { date: '2026-09-10', description: 'X teste', totalAmountCents: 1000 }
    await api.post('/api/transactions/installments', { ...base, installments: 1 }).expect(400)
    await api.post('/api/transactions/installments', { ...base, installments: 73 }).expect(400)
  })
})
