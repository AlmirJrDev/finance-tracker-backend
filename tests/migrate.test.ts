import { describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { migrate } from '../scripts/migrate-v2'
import { login, useTestApp } from './helpers'

const ctx = useTestApp()
const { Decimal128, ObjectId } = mongoose.mongo
const quiet = () => {}

async function seedLegacy(userId: string) {
  const db = mongoose.connection.db!
  const uid = new ObjectId(userId)
  const category = await db.collection('categories').findOne({ userId: uid, name: 'Alimentação' })
  const recurringId = new ObjectId()

  await db.collection('recurringtransactions').insertOne({
    _id: recurringId,
    userId: uid,
    description: 'Salário',
    amount: Decimal128.fromString('4500.50'),
    type: 'entrada',
    category: null,
    categoryName: null,
    frequency: 'monthly',
    dayOfMonth: 5,
    isActive: true,
    startDate: new Date('2026-01-01T00:00:00Z'),
    endDate: null,
    lastAppliedMonth: '2026-3',
  })

  const legacyTx = (overrides: Record<string, unknown>) => ({
    userId: uid,
    description: 'Mercado',
    amount: Decimal128.fromString('123.45'),
    type: 'saída',
    category: category!._id,
    categoryName: 'Alimentação',
    month: 3,
    year: 2026,
    isRecurringGenerated: false,
    parentRecurringId: null,
    date: new Date('2026-03-31T00:00:00Z'),
    ...overrides,
  })

  await db.collection('transactions').insertMany([
    legacyTx({}),
    // duas cópias da mesma ocorrência (bug antigo)
    legacyTx({ description: 'Salário', type: 'entrada', amount: Decimal128.fromString('4500.50'), category: null, parentRecurringId: recurringId, isRecurringGenerated: true, date: new Date('2026-03-05T00:00:00Z') }),
    legacyTx({ description: 'Salário', type: 'entrada', amount: Decimal128.fromString('4500.50'), category: null, parentRecurringId: recurringId, isRecurringGenerated: true, date: new Date('2026-03-05T00:00:00Z') }),
  ])
  await db.collection('monthlysummaries').insertOne({ userId: uid, year: 2026, month: 3 })
  return { recurringId, categoryId: category!._id }
}

describe('migração v1 → v2', () => {
  it('simulação não altera nada', async () => {
    const { user } = await login(ctx.app)
    await mongoose.connection.db!.collection('transactions').dropIndex('recurring_occurrence_unique').catch(() => {})
    await seedLegacy(user.id)

    const report = await migrate(mongoose.connection.db!, { apply: false, removeDuplicates: true, dropSummaries: true, log: quiet })
    expect(report).toMatchObject({ transactionsToMigrate: 3, recurringToMigrate: 1, duplicateDocs: 1 })
    expect(await mongoose.connection.db!.collection('transactions').countDocuments({ amountCents: { $exists: true } })).toBe(0)
  })

  it('converte os documentos e o resultado funciona na API nova', async () => {
    const { user, api } = await login(ctx.app)
    const db = mongoose.connection.db!
    await db.collection('transactions').dropIndex('recurring_occurrence_unique').catch(() => {})
    const { categoryId } = await seedLegacy(user.id)

    const report = await migrate(db, { apply: true, removeDuplicates: true, dropSummaries: true, log: quiet })
    expect(report).toMatchObject({ duplicatesRemoved: 1, summariesDropped: true, indexWarnings: [] })

    const tx = await db.collection('transactions').findOne({ description: 'Mercado' })
    expect(tx).toMatchObject({ amountCents: 12_345, date: '2026-03-31', type: 'expense', categoryId, recurringId: null })
    expect(tx).not.toHaveProperty('amount')
    expect(tx).not.toHaveProperty('categoryName')

    const summary = (await api.get('/api/summary/month/2026-03').expect(200)).body.data
    expect(summary).toMatchObject({ incomeCents: 450_050, expenseCents: 12_345, transactionCount: 2 })

    const recurring = (await api.get('/api/recurring-transactions').expect(200)).body.data
    expect(recurring[0]).toMatchObject({ amountCents: 450_050, type: 'income', startDate: '2026-01-01', endDate: null })

    // Reaplicar março não recria o salário que já existia
    const applied = await api.post('/api/recurring-transactions/apply', { from: '2026-03', to: '2026-03' }).expect(200)
    expect(applied.body.data).toEqual({ created: 0, existing: 1 })

    // Rodar de novo é seguro
    const second = await migrate(db, { apply: true, removeDuplicates: true, dropSummaries: true, log: quiet })
    expect(second).toMatchObject({ transactionsToMigrate: 0, recurringToMigrate: 0, duplicateDocs: 0 })
  })
})
