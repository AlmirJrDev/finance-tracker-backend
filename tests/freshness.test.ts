import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import mongoose from 'mongoose'
import { unconfirmGap } from '../scripts/unconfirm-gap'
import { occurrenceStatus } from '../src/services/recurrence'
import { createTx, login, useTestApp } from './helpers'

const ctx = useTestApp()

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-15T15:00:00Z'))
})
afterAll(() => {
  vi.useRealTimers()
})

describe('dados parados', () => {
  it('usuário sem transações não é considerado parado', async () => {
    const { api } = await login(ctx.app)
    const f = (await api.get('/api/summary/freshness').expect(200)).body.data
    expect(f).toMatchObject({ hasData: false, stale: false })
  })

  it('fica parado após 14 dias sem alterar nada e volta ao lançar', async () => {
    const { api } = await login(ctx.app)
    await createTx(api, { date: '2026-09-15' })
    expect((await api.get('/api/summary/freshness')).body.data).toMatchObject({ stale: false, daysSinceActivity: 0 })

    vi.setSystemTime(new Date('2026-10-01T15:00:00Z'))
    try {
      // Só visualizar não conta como atividade
      await api.get('/api/transactions').expect(200)
      const stale = (await api.get('/api/summary/freshness')).body.data
      expect(stale).toMatchObject({ stale: true, daysSinceActivity: 16, lastManualEntryDate: '2026-09-15', staleAfterDays: 14 })

      // Alterar qualquer coisa (ex.: marcar como pago) conta
      const [tx] = (await api.get('/api/transactions')).body.data
      await api.post('/api/transactions/status', { ids: [tx.id], status: 'paid' }).expect(200)
      expect((await api.get('/api/summary/freshness')).body.data).toMatchObject({ stale: false, daysSinceActivity: 0 })
    } finally {
      vi.setSystemTime(new Date('2026-09-15T15:00:00Z'))
    }
  })

  it('ocorrências recorrentes não contam como atividade do usuário', async () => {
    const { api, user } = await login(ctx.app)
    await createTx(api, { date: '2026-08-01' })
    await mongoose.connection.db!.collection('users').updateOne({ _id: new mongoose.Types.ObjectId(user.id) }, { $set: { lastActivityAt: new Date('2026-08-01T12:00:00Z') } })
    await mongoose.connection.db!.collection('transactions').updateOne({}, { $set: { createdAt: new Date('2026-08-01T12:00:00Z') } })
    await mongoose.connection.db!.collection('transactions').insertOne({
      userId: new mongoose.Types.ObjectId(user.id),
      recurringId: new mongoose.Types.ObjectId(),
      date: '2026-09-10',
      description: 'Aluguel',
      amountCents: 1000,
      type: 'expense',
      status: 'pending',
      createdAt: new Date('2026-09-10T12:00:00Z'),
    })
    expect((await api.get('/api/summary/freshness')).body.data).toMatchObject({ stale: true, daysSinceActivity: 45 })
  })
})

describe('não inventar histórico', () => {
  it('ocorrências passadas ficam a confirmar, exceto com confirmação automática', () => {
    expect(occurrenceStatus('2026-09-01', '2026-09-15', false)).toBe('pending')
    expect(occurrenceStatus('2026-09-15', '2026-09-15', false)).toBe('pending')
    expect(occurrenceStatus('2026-09-01', '2026-09-15', true)).toBe('paid')
    expect(occurrenceStatus('2026-09-20', '2026-09-15', true)).toBe('pending')
  })

  it('aplicar recorrência em meses passados gera pendências para revisar', async () => {
    const { api } = await login(ctx.app)
    await api
      .post('/api/recurring-transactions', { description: 'Aluguel', amountCents: 90_000, type: 'expense', frequency: 'monthly', dayOfMonth: 5, startDate: '2026-01-01' })
      .expect(201)
    await api.post('/api/recurring-transactions/apply', { from: '2026-07', to: '2026-09' }).expect(200)
    const statuses = (await api.get('/api/transactions?sort=asc')).body.data.map((t: { status: string }) => t.status)
    expect(statuses).toEqual(['pending', 'pending', 'pending'])
    expect((await api.get('/api/summary/projection')).body.data.overdue.count).toBe(3)
  })

  it('script volta para "a confirmar" o que foi marcado como pago durante a ausência', async () => {
    const { api, user } = await login(ctx.app)
    const db = mongoose.connection.db!
    const uid = new mongoose.Types.ObjectId(user.id)
    await createTx(api, { date: '2026-02-24', description: 'Último manual' })
    const auto = await api
      .post('/api/recurring-transactions', { description: 'Salário', amountCents: 300_000, type: 'income', frequency: 'monthly', dayOfMonth: 5, startDate: '2026-01-01', autoConfirm: true })
      .expect(201)
    const rent = await api
      .post('/api/recurring-transactions', { description: 'Aluguel', amountCents: 90_000, type: 'expense', frequency: 'monthly', dayOfMonth: 5, startDate: '2026-01-01' })
      .expect(201)
    const account = (await api.get('/api/accounts')).body.data[0]
    const occurrence = (recurringId: string, date: string) => ({
      userId: uid, recurringId: new mongoose.Types.ObjectId(recurringId), accountId: new mongoose.Types.ObjectId(account.id),
      date, description: 'x', amountCents: 100, type: 'expense', kind: 'regular', status: 'paid',
    })
    await db.collection('transactions').insertMany([
      occurrence(rent.body.data.id, '2026-02-05'), // antes da ausência: mantém
      occurrence(rent.body.data.id, '2026-04-05'), // durante: volta a pendente
      occurrence(rent.body.data.id, '2026-09-05'), // durante: volta a pendente
      occurrence(rent.body.data.id, '2026-10-05'), // futura: fora do intervalo
      occurrence(auto.body.data.id, '2026-04-05'), // automática: mantém
    ])

    const dry = await unconfirmGap(db, { userId: uid, today: '2026-09-15', apply: false })
    expect(dry).toMatchObject({ since: '2026-02-24', count: 2 })
    expect(await db.collection('transactions').countDocuments({ userId: uid, status: 'pending' })).toBe(0)

    const applied = await unconfirmGap(db, { userId: uid, today: '2026-09-15', apply: true })
    expect(applied.count).toBe(2)
    const pending = await db.collection('transactions').find({ userId: uid, status: 'pending' }).sort({ date: 1 }).toArray()
    expect(pending.map((t) => t.date)).toEqual(['2026-04-05', '2026-09-05'])
    expect((await unconfirmGap(db, { userId: uid, today: '2026-09-15', apply: false })).count).toBe(0)
  })
})
