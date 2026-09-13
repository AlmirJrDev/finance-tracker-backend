import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import mongoose from 'mongoose'
import { migrate } from '../scripts/migrate-v2'
import { createTx, login, useTestApp, type Api } from './helpers'

const ctx = useTestApp()

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-15T15:00:00Z'))
})
afterAll(() => {
  vi.useRealTimers()
})

async function newAccount(api: Api, name: string, type = 'checking') {
  const res = await api.post('/api/accounts', { name, type })
  if (res.status !== 201) throw new Error(JSON.stringify(res.body))
  return res.body.data
}

type AccountRow = { id: string; balanceCents: number; projectedBalanceCents: number }
const byId = (list: AccountRow[], id: string) => list.find((a) => a.id === id)!

describe('contas', () => {
  it('login cria a conta padrão e lançamentos sem conta vão para ela', async () => {
    const { api } = await login(ctx.app)
    const [main] = (await api.get('/api/accounts').expect(200)).body.data
    expect(main).toMatchObject({ name: 'Conta principal', isDefault: true, balanceCents: 0 })

    const tx = await createTx(api, { date: '2026-09-10', type: 'income', amountCents: 10_000 })
    expect(tx).toMatchObject({ accountId: main.id, kind: 'regular', source: 'manual' })
    const [after] = (await api.get('/api/accounts')).body.data
    expect(after).toMatchObject({ balanceCents: 10_000, projectedBalanceCents: 10_000, transactionCount: 1 })
  })

  it('saldo por conta, resumo filtrado e isolamento entre usuários', async () => {
    const ana = await login(ctx.app, 'ana@test.com')
    const bia = await login(ctx.app, 'bia@test.com')
    const card = await newAccount(ana.api, 'Nubank', 'credit_card')

    await createTx(ana.api, { date: '2026-09-05', type: 'income', amountCents: 500_000 })
    await createTx(ana.api, { date: '2026-09-06', amountCents: 20_000, accountId: card.id })
    await createTx(ana.api, { date: '2026-09-25', amountCents: 5_000, accountId: card.id }) // futura/pendente

    const accounts = (await ana.api.get('/api/accounts')).body.data
    expect(byId(accounts, card.id)).toMatchObject({ balanceCents: -20_000, projectedBalanceCents: -25_000 })

    const all = (await ana.api.get('/api/summary/month/2026-09')).body.data
    expect(all).toMatchObject({ incomeCents: 500_000, expenseCents: 25_000, finalBalanceCents: 475_000 })
    const onlyCard = (await ana.api.get(`/api/summary/month/2026-09?accountId=${card.id}`)).body.data
    expect(onlyCard).toMatchObject({ incomeCents: 0, expenseCents: 25_000, finalBalanceCents: -25_000 })
    const list = (await ana.api.get(`/api/transactions?accountId=${card.id}`)).body.data
    expect(list).toHaveLength(2)

    await bia.api.post('/api/transactions', { date: '2026-09-10', description: 'X teste', amountCents: 1, type: 'expense', accountId: card.id }).expect(404)
    await bia.api.get(`/api/summary/month/2026-09?accountId=${card.id}`).expect(404)
    await bia.api.put(`/api/accounts/${card.id}`, { name: 'Roubo' }).expect(404)
  })

  it('transferência mexe nos saldos, mas não em receitas, despesas, categorias ou orçamentos', async () => {
    const { api } = await login(ctx.app)
    const [main] = (await api.get('/api/accounts')).body.data
    const savings = await newAccount(api, 'Poupança', 'savings')
    const food = (await api.get('/api/categories')).body.data.find((c: { name: string }) => c.name === 'Alimentação')
    await api.put(`/api/budgets/${food.id}`, { amountCents: 10_000 }).expect(200)

    await createTx(api, { date: '2026-09-01', type: 'income', amountCents: 300_000 })
    await createTx(api, { date: '2026-09-02', amountCents: 8_000, categoryId: food.id })
    const transfer = (
      await api.post('/api/accounts/transfers', { fromAccountId: main.id, toAccountId: savings.id, amountCents: 100_000, date: '2026-09-03' }).expect(201)
    ).body.data
    expect(transfer.from).toMatchObject({ kind: 'transfer', type: 'expense', description: 'Transferência para Poupança' })
    expect(transfer.to).toMatchObject({ kind: 'transfer', type: 'income', transferId: transfer.transferId })

    const accounts = (await api.get('/api/accounts')).body.data
    expect(byId(accounts, main.id).balanceCents).toBe(192_000)
    expect(byId(accounts, savings.id).balanceCents).toBe(100_000)

    const month = (await api.get('/api/summary/month/2026-09')).body.data
    expect(month).toMatchObject({ incomeCents: 300_000, expenseCents: 8_000, finalBalanceCents: 292_000, otherMovementsCents: 0 })
    // "Sem categoria" é só a receita; os R$ 1.000 transferidos não aparecem em nenhuma categoria
    expect(month.byCategory).toEqual([
      expect.objectContaining({ name: 'Alimentação', expenseCents: 8_000 }),
      expect.objectContaining({ name: 'Sem categoria', incomeCents: 300_000, expenseCents: 0, transactionCount: 1 }),
    ])
    expect((await api.get('/api/budgets?month=2026-09')).body.data[0].totalCents).toBe(8_000)

    const saving = (await api.get(`/api/summary/month/2026-09?accountId=${savings.id}`)).body.data
    expect(saving).toMatchObject({ incomeCents: 0, expenseCents: 0, finalBalanceCents: 100_000, otherMovementsCents: 100_000 })

    // Editar uma perna atualiza as duas; tipo e categoria são bloqueados
    await api.put(`/api/transactions/${transfer.to.id}`, { amountCents: 50_000 }).expect(200)
    expect((await api.get(`/api/transactions/${transfer.from.id}`)).body.data.amountCents).toBe(50_000)
    await api.put(`/api/transactions/${transfer.to.id}`, { type: 'expense' }).expect(400)
    await api.put(`/api/transactions/${transfer.to.id}`, { categoryId: food.id }).expect(400)

    // Excluir uma perna exclui as duas
    await api.delete(`/api/transactions/${transfer.from.id}`).expect(200)
    await api.get(`/api/transactions/${transfer.to.id}`).expect(404)

    await api.post('/api/accounts/transfers', { fromAccountId: main.id, toAccountId: main.id, amountCents: 1, date: '2026-09-03' }).expect(400)
  })

  it('ajuste de saldo cria lançamento que não é receita nem despesa', async () => {
    const { api } = await login(ctx.app)
    const wallet = await newAccount(api, 'Carteira', 'cash')
    await createTx(api, { date: '2026-09-10', amountCents: 3_000, accountId: wallet.id })

    const adj = await api.post(`/api/accounts/${wallet.id}/adjust`, { balanceCents: 12_000, date: '2026-09-12' }).expect(201)
    expect(adj.body.data).toMatchObject({ kind: 'adjustment', type: 'income', amountCents: 15_000 })
    await api.post(`/api/accounts/${wallet.id}/adjust`, { balanceCents: 12_000, date: '2026-09-12' }).expect(200)

    const s = (await api.get(`/api/summary/month/2026-09?accountId=${wallet.id}`)).body.data
    expect(s).toMatchObject({ incomeCents: 0, expenseCents: 3_000, finalBalanceCents: 12_000, otherMovementsCents: 15_000 })
  })

  it('remover conta exige destino quando há lançamentos; a padrão é protegida', async () => {
    const { api } = await login(ctx.app)
    const [main] = (await api.get('/api/accounts')).body.data
    const old = await newAccount(api, 'Conta antiga')
    await createTx(api, { accountId: old.id })

    await api.delete(`/api/accounts/${main.id}`).expect(403)
    await api.put(`/api/accounts/${main.id}`, { isArchived: true }).expect(400)
    const blocked = await api.delete(`/api/accounts/${old.id}`).expect(409)
    expect(blocked.body.details).toMatchObject({ transactionCount: 1 })

    const res = await api.delete(`/api/accounts/${old.id}?moveTo=${main.id}`).expect(200)
    expect(res.body.data.movedCount).toBe(1)
    expect((await api.get('/api/accounts')).body.data).toHaveLength(1)

    // Trocar a conta padrão
    const other = await newAccount(api, 'Inter')
    await api.put(`/api/accounts/${other.id}`, { isDefault: true }).expect(200)
    const accounts = (await api.get('/api/accounts')).body.data
    expect(accounts.filter((a: { isDefault: boolean }) => a.isDefault).map((a: { id: string }) => a.id)).toEqual([other.id])
    await api.post('/api/accounts', { name: 'inter' }).expect(409)
  })

  it('recorrência gera na conta escolhida e a projeção filtra por conta', async () => {
    const { api } = await login(ctx.app)
    const card = await newAccount(api, 'Cartão', 'credit_card')
    await api
      .post('/api/recurring-transactions', {
        description: 'Streaming',
        amountCents: 5_590,
        type: 'expense',
        frequency: 'monthly',
        dayOfMonth: 20,
        startDate: '2026-01-01',
        accountId: card.id,
      })
      .expect(201)

    const cardProjection = (await api.get(`/api/summary/projection?days=30&accountId=${card.id}`)).body.data
    expect(cardProjection.endBalanceCents).toBe(-5_590)
    expect(cardProjection.upcoming[0]).toMatchObject({ accountId: card.id, virtual: true })

    await api.post('/api/recurring-transactions/apply', { from: '2026-09', to: '2026-09' }).expect(200)
    const [tx] = (await api.get('/api/transactions?month=2026-09')).body.data
    expect(tx).toMatchObject({ accountId: card.id, description: 'Streaming' })
  })

  it('migração vincula lançamentos antigos à conta padrão', async () => {
    const { user } = await login(ctx.app)
    const db = mongoose.connection.db!
    const uid = new mongoose.Types.ObjectId(user.id)
    await db.collection('accounts').deleteMany({ userId: uid })
    await db.collection('transactions').insertOne({ userId: uid, date: '2026-09-01', description: 'Antiga', amountCents: 100, type: 'expense', status: 'paid' })
    await db.collection('recurringtransactions').insertOne({ userId: uid, description: 'Antiga', amountCents: 100, type: 'expense', frequency: 'monthly', dayOfMonth: 1, startDate: '2026-01-01', isActive: true })

    const dry = await migrate(db, { apply: false, removeDuplicates: false, dropSummaries: false, log: () => {} })
    expect(dry.withoutAccount).toBe(2)
    const report = await migrate(db, { apply: true, removeDuplicates: false, dropSummaries: false, log: () => {} })
    expect(report.accountsCreated).toBe(1)

    const account = await db.collection('accounts').findOne({ userId: uid, isDefault: true })
    expect(await db.collection('transactions').findOne({ userId: uid })).toMatchObject({ accountId: account!._id })
    expect(await db.collection('recurringtransactions').findOne({ userId: uid })).toMatchObject({ accountId: account!._id })
    expect((await migrate(db, { apply: true, removeDuplicates: false, dropSummaries: false, log: () => {} })).withoutAccount).toBe(0)
  })
})
