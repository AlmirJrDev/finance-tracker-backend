import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { Transaction } from '../src/models/Transaction'
import { createTx, login, useTestApp, type Api } from './helpers'

const ctx = useTestApp()

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-15T15:00:00Z'))
})
afterAll(() => {
  vi.useRealTimers()
})

async function recurring(api: Api, overrides: Record<string, unknown> = {}) {
  const res = await api.post('/api/recurring-transactions', {
    description: 'Aluguel',
    amountCents: 150_000,
    type: 'expense',
    frequency: 'monthly',
    dayOfMonth: 20,
    startDate: '2026-01-01',
    ...overrides,
  })
  if (res.status !== 201) throw new Error(JSON.stringify(res.body))
  return res.body.data
}

describe('projeção de saldo', () => {
  it('soma pendentes e recorrências não aplicadas, sem contar duas vezes', async () => {
    const { api } = await login(ctx.app)
    await createTx(api, { date: '2026-09-05', type: 'income', amountCents: 300_000 })
    await createTx(api, { date: '2026-09-18', amountCents: 20_000 }) // pendente futura
    await recurring(api)
    // Setembro já aplicado (20/09 pendente); outubro em diante só existe como regra
    await api.post('/api/recurring-transactions/apply', { from: '2026-09', to: '2026-09' }).expect(200)

    const p = (await api.get('/api/summary/projection?days=60').expect(200)).body.data
    expect(p).toMatchObject({ today: '2026-09-15', realizedBalanceCents: 300_000, projectedTodayCents: 300_000 })

    const at = (date: string) => p.points.find((pt: { date: string }) => date === pt.date).balanceCents
    expect(at('2026-09-18')).toBe(280_000)
    expect(at('2026-09-20')).toBe(130_000)
    expect(at('2026-10-20')).toBe(-20_000) // ocorrência virtual de outubro
    expect(p.firstNegativeDate).toBe('2026-10-20')
    // Menor saldo: o primeiro dia em que ele acontece (o aluguel de novembro fica fora dos 60 dias)
    expect(p.lowest).toEqual({ date: '2026-10-20', balanceCents: -20_000 })
    expect(p.endBalanceCents).toBe(-20_000)
    expect(p.points).toHaveLength(61)

    // Próximos 7 dias: a transação de 18/09 e o aluguel aplicado de 20/09 (não virtual)
    expect(p.upcoming.map((u: { date: string; virtual: boolean }) => [u.date, u.virtual])).toEqual([
      ['2026-09-18', false],
      ['2026-09-20', false],
    ])
  })

  it('mostra o aluguel virtual nos próximos dias quando ainda não foi aplicado', async () => {
    const { api } = await login(ctx.app)
    await recurring(api, { dayOfMonth: 17 })
    const p = (await api.get('/api/summary/projection?days=30')).body.data
    expect(p.upcoming).toEqual([expect.objectContaining({ date: '2026-09-17', virtual: true, id: null })])
  })

  it('conta as atrasadas', async () => {
    const { api } = await login(ctx.app)
    await createTx(api, { date: '2026-09-01', amountCents: 9_990, status: 'pending' })
    await createTx(api, { date: '2026-09-02', amountCents: 10, status: 'pending' })
    const p = (await api.get('/api/summary/projection')).body.data
    expect(p.overdue).toEqual({ count: 2, incomeCents: 0, expenseCents: 10_000 })
    expect(p.realizedBalanceCents).toBe(0)
    expect(p.projectedTodayCents).toBe(-10_000)
  })
})

describe('recorrências com status', () => {
  it('ocorrências passadas nascem pagas e futuras pendentes; cron confirma as automáticas', async () => {
    const { api } = await login(ctx.app)
    await recurring(api, { description: 'Salário', type: 'income', frequency: 'weekly', dayOfWeek: 2, dayOfMonth: null, autoConfirm: true })
    await api.post('/api/recurring-transactions/apply', { from: '2026-09', to: '2026-09' }).expect(200)

    const txs = (await api.get('/api/transactions?month=2026-09&sort=asc')).body.data
    // terças: 01, 08, 15 (hoje, automática → paga), 22, 29
    expect(txs.map((t: { date: string; status: string }) => `${t.date}:${t.status}`)).toEqual([
      '2026-09-01:paid',
      '2026-09-08:paid',
      '2026-09-15:paid',
      '2026-09-22:pending',
      '2026-09-29:pending',
    ])

    vi.setSystemTime(new Date('2026-09-23T15:00:00Z'))
    try {
      await request(ctx.app).get('/api/cron/recurring').expect(401)
      const cron = await request(ctx.app)
        .get('/api/cron/recurring')
        .set('Authorization', 'Bearer cron-secret-de-teste-123')
        .expect(200)
      expect(cron.body.data).toMatchObject({ users: 1, confirmed: 1 })
      // Gerou outubro também (4 terças: 06, 13, 20, 27)
      expect(cron.body.data.created).toBe(4)
      expect(await Transaction.countDocuments({ status: 'pending' })).toBe(5)
    } finally {
      vi.setSystemTime(new Date('2026-09-15T15:00:00Z'))
    }
  })
})

describe('orçamentos', () => {
  it('calcula gasto pago, pendente e nível de alerta', async () => {
    const { api } = await login(ctx.app)
    const categories = (await api.get('/api/categories')).body.data
    const food = categories.find((c: { name: string }) => c.name === 'Alimentação')
    const fun = categories.find((c: { name: string }) => c.name === 'Lazer')

    await api.put(`/api/budgets/${food.id}`, { amountCents: 100_000 }).expect(200)
    await api.put(`/api/budgets/${fun.id}`, { amountCents: 50_000, alertPercent: 50 }).expect(200)
    await createTx(api, { categoryId: food.id, date: '2026-09-10', amountCents: 70_000 })
    await createTx(api, { categoryId: food.id, date: '2026-09-25', amountCents: 40_000 }) // pendente
    await createTx(api, { categoryId: fun.id, date: '2026-09-11', amountCents: 25_000 })
    await createTx(api, { categoryId: fun.id, date: '2026-08-11', amountCents: 99_000 }) // outro mês

    const list = (await api.get('/api/budgets?month=2026-09').expect(200)).body.data
    expect(list).toEqual([
      expect.objectContaining({
        categoryId: food.id,
        paidCents: 70_000,
        pendingCents: 40_000,
        totalCents: 110_000,
        remainingCents: -10_000,
        percent: 110,
        level: 'exceeded',
      }),
      expect.objectContaining({ categoryId: fun.id, totalCents: 25_000, percent: 50, level: 'warning' }),
    ])
    // Sem ?month usa o mês atual do usuário
    expect((await api.get('/api/budgets')).body.data[0].month).toBe('2026-09')
  })

  it('atualiza, remove, isola usuários e some com a categoria', async () => {
    const ana = await login(ctx.app, 'ana@test.com')
    const bia = await login(ctx.app, 'bia@test.com')
    const cat = (await ana.api.post('/api/categories', { name: 'Pets' })).body.data

    await ana.api.put(`/api/budgets/${cat.id}`, { amountCents: 10_000 }).expect(200)
    await ana.api.put(`/api/budgets/${cat.id}`, { amountCents: 20_000 }).expect(200)
    expect((await ana.api.get('/api/budgets')).body.data).toHaveLength(1)
    expect((await ana.api.get('/api/budgets')).body.data[0].amountCents).toBe(20_000)

    await bia.api.put(`/api/budgets/${cat.id}`, { amountCents: 1 }).expect(404)
    await bia.api.delete(`/api/budgets/${cat.id}`).expect(404)

    await ana.api.delete(`/api/categories/${cat.id}`).expect(200)
    expect((await ana.api.get('/api/budgets')).body.data).toHaveLength(0)
  })
})
