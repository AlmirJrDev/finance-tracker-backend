import { describe, expect, it } from 'vitest'
import { createTx, login, useTestApp } from './helpers'

const ctx = useTestApp()

describe('resumos', () => {
  it('leva o saldo adiante mesmo com meses sem movimento no meio', async () => {
    const { api } = await login(ctx.app)
    await createTx(api, { date: '2026-01-05', type: 'income', amountCents: 500_000, description: 'Salário' })
    await createTx(api, { date: '2026-01-20', type: 'expense', amountCents: 120_000 })
    // fevereiro sem transações
    await createTx(api, { date: '2026-03-02', type: 'expense', amountCents: 30_000 })

    const march = (await api.get('/api/summary/month/2026-03').expect(200)).body.data
    expect(march).toMatchObject({
      month: '2026-03',
      initialBalanceCents: 380_000,
      incomeCents: 0,
      expenseCents: 30_000,
      resultCents: -30_000,
      finalBalanceCents: 350_000,
      transactionCount: 1,
    })
    expect(march.days).toHaveLength(31)
    expect(march.days[0]).toMatchObject({ date: '2026-03-01', balanceCents: 380_000 })
    expect(march.days[1]).toMatchObject({ date: '2026-03-02', expenseCents: 30_000, balanceCents: 350_000 })
  })

  it('recalcula na hora depois de editar uma transação antiga', async () => {
    const { api } = await login(ctx.app)
    const old = await createTx(api, { date: '2026-01-05', type: 'income', amountCents: 100_000 })
    await createTx(api, { date: '2026-06-01', amountCents: 10_000 })

    await api.put(`/api/transactions/${old.id}`, { amountCents: 50_000 }).expect(200)
    const june = (await api.get('/api/summary/month/2026-06')).body.data
    expect(june.initialBalanceCents).toBe(50_000)
    expect(june.finalBalanceCents).toBe(40_000)
  })

  it('agrupa por categoria, incluindo transações sem categoria', async () => {
    const { api } = await login(ctx.app)
    const categories = (await api.get('/api/categories')).body.data
    const food = categories.find((c: { name: string }) => c.name === 'Alimentação')

    await createTx(api, { categoryId: food.id, amountCents: 3_000 })
    await createTx(api, { categoryId: food.id, amountCents: 2_000 })
    await createTx(api, { amountCents: 1_000 })

    const { byCategory } = (await api.get('/api/summary/month/2026-03')).body.data
    expect(byCategory).toEqual([
      expect.objectContaining({ categoryId: food.id, name: 'Alimentação', expenseCents: 5_000, transactionCount: 2 }),
      expect.objectContaining({ categoryId: null, name: 'Sem categoria', expenseCents: 1_000 }),
    ])
  })

  it('resumo anual em uma única chamada, com saldo encadeado', async () => {
    const { api } = await login(ctx.app)
    await createTx(api, { date: '2025-12-31', type: 'income', amountCents: 10_000 })
    await createTx(api, { date: '2026-02-10', type: 'income', amountCents: 20_000 })
    await createTx(api, { date: '2026-11-10', amountCents: 5_000 })

    const year = (await api.get('/api/summary/year/2026').expect(200)).body.data
    expect(year.months).toHaveLength(12)
    expect(year.initialBalanceCents).toBe(10_000)
    expect(year.months[0].finalBalanceCents).toBe(10_000)
    expect(year.months[1].finalBalanceCents).toBe(30_000)
    expect(year.months[10]).toMatchObject({ initialBalanceCents: 30_000, finalBalanceCents: 25_000 })
    expect(year.finalBalanceCents).toBe(25_000)
    expect(year.months[1].days).toHaveLength(28)
  })

  it('lista os meses com movimento, do mais recente para o mais antigo', async () => {
    const { api } = await login(ctx.app)
    await createTx(api, { date: '2026-01-05' })
    await createTx(api, { date: '2026-03-05' })
    await createTx(api, { date: '2026-03-06' })

    const res = await api.get('/api/summary/months').expect(200)
    expect(res.body.data).toEqual([
      { month: '2026-03', transactionCount: 2 },
      { month: '2026-01', transactionCount: 1 },
    ])
    await api.get('/api/summary/month/2026-13').expect(400)
  })
})
