import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { pluggyApi, type PluggyAccount, type PluggyTransaction } from '../src/lib/pluggy'
import { isInternalMovement, pluggyDate } from '../src/services/bank-sync'
import { login, useTestApp } from './helpers'

const ctx = useTestApp()

const ITEM_ID = '11111111-2222-4333-8444-555555555555'

// Banco simulado: uma conta corrente e um cartão
let accounts: PluggyAccount[]
let transactions: Record<string, PluggyTransaction[]>

function tx(accountId: string, id: string, date: string, amount: number, type: 'DEBIT' | 'CREDIT', description: string): PluggyTransaction {
  return { id, accountId, date, amount, type, description, status: 'POSTED' }
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-15T15:00:00Z'))
})
afterAll(() => {
  vi.useRealTimers()
})

function mockBank(clientUserId: string | null = null) {
  accounts = [
    { id: 'acc-checking', itemId: ITEM_ID, type: 'BANK', subtype: 'CHECKING_ACCOUNT', name: 'Conta', balance: 1234.56 },
    { id: 'acc-card', itemId: ITEM_ID, type: 'CREDIT', subtype: 'CREDIT_CARD', name: 'Cartão', marketingName: 'Ultravioleta', balance: 350.0 },
  ]
  transactions = {
    'acc-checking': [
      // 00:30 em UTC de 02/09 ainda é 01/09 em Brasília
      tx('acc-checking', 't1', '2026-09-02T00:30:00.000Z', 5000, 'CREDIT', 'Salário ACME'),
      tx('acc-checking', 't2', '2026-09-05T15:00:00.000Z', -89.9, 'DEBIT', 'iFood'),
      tx('acc-checking', 't3', '2026-09-10T15:00:00.000Z', -500, 'DEBIT', 'Pagamento de fatura'),
      tx('acc-checking', 't-old', '2026-08-20T15:00:00.000Z', -10, 'DEBIT', 'Antes do início'),
    ],
    'acc-card': [
      tx('acc-card', 'c1', '2026-09-03T15:00:00.000Z', 120, 'DEBIT', 'Uber'),
      tx('acc-card', 'c2', '2026-09-10T15:00:00.000Z', -500, 'CREDIT', 'Pagamento recebido'),
    ],
  }
  vi.spyOn(pluggyApi, 'getItem').mockImplementation(async (id) => ({
    id,
    status: 'UPDATED',
    clientUserId,
    connector: { id: 200, name: 'MeuPluggy' },
  }))
  vi.spyOn(pluggyApi, 'listAccounts').mockImplementation(async () => accounts)
  vi.spyOn(pluggyApi, 'listTransactions').mockImplementation(async (accountId) => transactions[accountId] ?? [])
  vi.spyOn(pluggyApi, 'createConnectToken').mockResolvedValue('connect-token-fake')
  vi.spyOn(pluggyApi, 'deleteItem').mockResolvedValue()
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('regras de importação', () => {
  it('converte a data para o dia de Brasília e reconhece movimentos internos', () => {
    expect(pluggyDate('2026-09-02T00:30:00.000Z')).toBe('2026-09-01')
    expect(pluggyDate('2026-09-02T03:00:00.000Z')).toBe('2026-09-02')
    expect(isInternalMovement({ description: 'Pagamento recebido', category: null })).toBe(true)
    expect(isInternalMovement({ description: 'Mercado', category: 'Credit card payment' })).toBe(true)
    expect(isInternalMovement({ description: 'Uber', category: 'Transportation' })).toBe(false)
  })
})

describe('conexão bancária (Pluggy)', () => {
  it('só o titular autorizado pode conectar', async () => {
    mockBank()
    const bia = await login(ctx.app, 'bia@test.com')
    const status = (await bia.api.get('/api/connections/status').expect(200)).body.data
    expect(status).toMatchObject({ enabled: true, allowed: false, connectorId: 200 })
    await bia.api.post('/api/connections/connect-token').expect(403)
    await bia.api.post('/api/connections', { itemId: ITEM_ID }).expect(403)
  })

  it('conecta, importa contas e transações e deixa o saldo igual ao do banco', async () => {
    mockBank()
    const { api } = await login(ctx.app, 'ana@test.com')
    expect((await api.post('/api/connections/connect-token').expect(200)).body.data.accessToken).toBe('connect-token-fake')

    const res = await api.post('/api/connections', { itemId: ITEM_ID, importFrom: '2026-09-01' }).expect(201)
    expect(res.body.data.sync).toMatchObject({ accounts: 2, created: 5, skipped: 1 })
    expect(res.body.data.connection).toMatchObject({ connectorName: 'MeuPluggy', status: 'UPDATED', lastSyncError: null })
    expect(res.body.data.connection.accounts.map((a: { name: string }) => a.name).sort()).toEqual(['MeuPluggy Conta', 'MeuPluggy Ultravioleta'])

    const all = (await api.get('/api/accounts')).body.data
    const checking = all.find((a: { name: string }) => a.name === 'MeuPluggy Conta')
    const card = all.find((a: { name: string }) => a.name === 'MeuPluggy Ultravioleta')
    expect(checking).toMatchObject({ type: 'checking', balanceCents: 123_456, provider: { name: 'pluggy', connectorName: 'MeuPluggy' } })
    expect(card).toMatchObject({ type: 'credit_card', balanceCents: -35_000 })

    const imported = (await api.get(`/api/transactions?accountId=${checking.id}&sort=asc`)).body.data
    expect(imported.map((t: { date: string; description: string; kind: string; type: string; source: string }) => [t.date, t.description, t.kind, t.type, t.source])).toEqual([
      ['2026-08-31', 'Saldo antes da sincronização', 'adjustment', 'expense', 'pluggy'],
      ['2026-09-01', 'Salário ACME', 'regular', 'income', 'pluggy'],
      ['2026-09-05', 'iFood', 'regular', 'expense', 'pluggy'],
      ['2026-09-10', 'Pagamento de fatura', 'transfer', 'expense', 'pluggy'],
    ])
    expect(imported[1].category?.name).toBe('Salário')
    expect(imported[2].category?.name).toBe('Alimentação')

    // Compra no cartão é despesa; pagamento da fatura não conta como receita nem despesa
    const month = (await api.get('/api/summary/month/2026-09')).body.data
    expect(month).toMatchObject({ incomeCents: 500_000, expenseCents: 8_990 + 12_000 })

    // Dados do banco mantêm o usuário "em dia"
    expect((await api.get('/api/summary/freshness')).body.data.stale).toBe(false)
  })

  it('sincronizar de novo não duplica, atualiza valores e preserva a categoria escolhida', async () => {
    mockBank()
    const { api } = await login(ctx.app, 'ana@test.com')
    await api.post('/api/connections', { itemId: ITEM_ID, importFrom: '2026-09-01' }).expect(201)
    const [conn] = (await api.get('/api/connections')).body.data
    const lazer = (await api.get('/api/categories')).body.data.find((c: { name: string }) => c.name === 'Lazer')
    const ifood = (await api.get('/api/transactions?q=iFood')).body.data[0]
    await api.put(`/api/transactions/${ifood.id}`, { categoryId: lazer.id }).expect(200)

    // Banco corrigiu o valor e chegou uma transação nova
    transactions['acc-checking'][1].amount = -99.9
    transactions['acc-checking'].push(tx('acc-checking', 't4', '2026-09-14T15:00:00.000Z', -40, 'DEBIT', 'Farmácia'))
    accounts[0].balance = 1184.56

    vi.setSystemTime(new Date('2026-09-15T15:10:00Z'))
    try {
      const again = await api.post(`/api/connections/${conn.id}/sync`).expect(200)
      expect(again.body.data.sync).toMatchObject({ created: 1 })
      // Muito cedo para sincronizar de novo
      await api.post(`/api/connections/${conn.id}/sync`).expect(429)
    } finally {
      vi.setSystemTime(new Date('2026-09-15T15:00:00Z'))
    }

    const updated = (await api.get(`/api/transactions/${ifood.id}`)).body.data
    expect(updated).toMatchObject({ amountCents: 9_990, categoryId: lazer.id })
    expect((await api.get('/api/transactions?q=Farm')).body.data).toHaveLength(1)
    const checking = (await api.get('/api/accounts')).body.data.find((a: { name: string }) => a.name === 'MeuPluggy Conta')
    expect(checking.balanceCents).toBe(118_456)
  })

  it('não aceita conexão de outro usuário da Pluggy', async () => {
    mockBank('outro-usuario')
    const { api } = await login(ctx.app, 'ana@test.com')
    await api.post('/api/connections', { itemId: ITEM_ID }).expect(404)
  })

  it('desconectar mantém o histórico como manual ou apaga os dados importados', async () => {
    mockBank()
    const { api } = await login(ctx.app, 'ana@test.com')
    await api.post('/api/connections', { itemId: ITEM_ID, importFrom: '2026-09-01' }).expect(201)
    const [conn] = (await api.get('/api/connections')).body.data

    await api.delete(`/api/connections/${conn.id}`).expect(200)
    expect(pluggyApi.deleteItem).toHaveBeenCalledWith(ITEM_ID)
    const kept = (await api.get('/api/accounts')).body.data
    expect(kept.filter((a: { provider: unknown }) => a.provider)).toHaveLength(0)
    expect(kept.some((a: { name: string }) => a.name === 'MeuPluggy Conta')).toBe(true)

    // Reconecta e remove apagando os dados
    await api.post('/api/connections', { itemId: ITEM_ID, importFrom: '2026-09-01' }).expect(201)
    const [again] = (await api.get('/api/connections')).body.data
    const removed = await api.delete(`/api/connections/${again.id}?deleteData=true`).expect(200)
    expect(removed.body.data.deletedTransactions).toBeGreaterThan(0)
    expect((await api.get('/api/transactions?limit=500')).body.data.filter((t: { source: string }) => t.source === 'pluggy')).toHaveLength(0)
  })

  it('webhook sincroniza a conexão pelo itemId e ignora itens desconhecidos', async () => {
    mockBank()
    const { api } = await login(ctx.app, 'ana@test.com')
    await api.post('/api/connections', { itemId: ITEM_ID, importFrom: '2026-09-01' }).expect(201)
    transactions['acc-card'].push(tx('acc-card', 'c3', '2026-09-14T15:00:00.000Z', 30, 'DEBIT', 'Cinema'))

    await request(ctx.app).post('/api/webhooks/pluggy').send({ event: 'transactions/created', itemId: ITEM_ID }).expect(200)
    expect((await api.get('/api/transactions?q=Cinema')).body.data).toHaveLength(1)
    await request(ctx.app).post('/api/webhooks/pluggy').send({ event: 'item/updated', itemId: 'desconhecido' }).expect(200)
  })
})
