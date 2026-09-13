import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import mongoose from 'mongoose'
import { backupDb, restoreDb } from '../scripts/backup'
import { login, useTestApp } from './helpers'

const ctx = useTestApp()
const dir = mkdtempSync(path.join(tmpdir(), 'ft-backup-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('backup e restauração', () => {
  it('preserva tipos do formato antigo (Decimal128, Date, ObjectId)', async () => {
    await login(ctx.app)
    const db = mongoose.connection.db!
    const { Decimal128, ObjectId } = mongoose.mongo
    const legacyId = new ObjectId()
    await db.collection('transactions').insertOne({
      _id: legacyId,
      amount: Decimal128.fromString('123.45'),
      date: new Date('2026-03-31T00:00:00Z'),
      description: 'Legado',
    })

    const counts = await backupDb(db, dir)
    expect(counts.transactions).toBe(1)
    expect(counts.categories).toBe(7)

    await db.collection('transactions').deleteMany({})
    await db.collection('categories').insertOne({ name: 'lixo' })

    await restoreDb(db, dir)
    const restored = await db.collection('transactions').findOne({ _id: legacyId })
    expect(restored?.amount).toBeInstanceOf(Decimal128)
    expect(restored?.amount.toString()).toBe('123.45')
    expect(restored?.date).toEqual(new Date('2026-03-31T00:00:00Z'))
    expect(await db.collection('categories').countDocuments()).toBe(7)
  })
})
