/**
 * Migração dos dados do formato v1 para o v2.
 *
 *   v1: amount Decimal128, date Date, type 'entrada'|'saída', category, parentRecurringId, monthlysummaries
 *   v2: amountCents inteiro, date "YYYY-MM-DD", type 'income'|'expense', categoryId, recurringId
 *
 * Uso:
 *   npm run migrate:v2                          -> simulação (não altera nada)
 *   npm run migrate:v2 -- --apply               -> aplica
 *   npm run migrate:v2 -- --apply --remove-duplicates --drop-summaries
 *
 * É idempotente: documentos já migrados são ignorados.
 */
import 'dotenv/config'
import mongoose from 'mongoose'
import type { Db, Document } from 'mongodb'

export type MigrateOptions = {
  apply: boolean
  removeDuplicates: boolean
  dropSummaries: boolean
  log?: (msg: string) => void
}

export type MigrateReport = {
  transactionsToMigrate: number
  recurringToMigrate: number
  duplicateGroups: number
  duplicateDocs: number
  duplicatesRemoved: number
  categoryNameConflicts: string[]
  summariesDropped: boolean
  indexWarnings: string[]
  samples: Document[]
}

const toCents = (field: string) => ({
  $toInt: { $round: [{ $multiply: [{ $toDecimal: field }, 100] }, 0] },
})
const toDay = (field: string) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: 'UTC' } })
const toType = { $cond: [{ $eq: ['$type', 'entrada'] }, 'income', 'expense'] }

const legacyTransaction = { amount: { $exists: true }, amountCents: { $exists: false } }
const legacyRecurring = { amount: { $exists: true }, amountCents: { $exists: false } }

async function dropIndexIfExists(db: Db, collection: string, name: string, log: (m: string) => void) {
  const exists = await db
    .collection(collection)
    .indexExists(name)
    .catch(() => false)
  if (exists) {
    await db.collection(collection).dropIndex(name)
    log(`  índice removido: ${collection}.${name}`)
  }
}

export async function migrate(db: Db, opts: MigrateOptions): Promise<MigrateReport> {
  const log = opts.log ?? console.log
  const transactions = db.collection('transactions')
  const recurring = db.collection('recurringtransactions')
  const categories = db.collection('categories')

  const report: MigrateReport = {
    transactionsToMigrate: await transactions.countDocuments(legacyTransaction),
    recurringToMigrate: await recurring.countDocuments(legacyRecurring),
    duplicateGroups: 0,
    duplicateDocs: 0,
    duplicatesRemoved: 0,
    categoryNameConflicts: [],
    summariesDropped: false,
    indexWarnings: [],
    samples: [],
  }

  log(`Transações a migrar: ${report.transactionsToMigrate}`)
  log(`Recorrências a migrar: ${report.recurringToMigrate}`)

  report.samples = await transactions
    .aggregate([
      { $match: { ...legacyTransaction, date: { $type: 'date' } } },
      { $limit: 3 },
      {
        $project: {
          antes: { amount: { $toString: '$amount' }, date: '$date', type: '$type' },
          depois: { amountCents: toCents('$amount'), date: toDay('$date'), type: toType },
        },
      },
    ])
    .toArray()

  // Duplicatas geradas pelo bug do lastAppliedMonth (mesma recorrência, mesmo dia)
  const duplicates = await transactions
    .aggregate<{ _id: unknown; ids: mongoose.Types.ObjectId[]; count: number }>([
      { $match: { $or: [{ parentRecurringId: { $type: 'objectId' } }, { recurringId: { $type: 'objectId' } }] } },
      {
        $group: {
          _id: {
            userId: '$userId',
            recurring: { $ifNull: ['$recurringId', '$parentRecurringId'] },
            day: { $cond: [{ $eq: [{ $type: '$date' }, 'date'] }, toDay('$date'), '$date'] },
          },
          ids: { $push: '$_id' },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray()
  report.duplicateGroups = duplicates.length
  report.duplicateDocs = duplicates.reduce((s, d) => s + d.count - 1, 0)
  log(`Transações recorrentes duplicadas: ${report.duplicateDocs} (em ${report.duplicateGroups} ocorrências)`)

  // Categorias que passam a colidir com o índice sem diferenciar maiúsculas/acentos
  const conflicts = await categories
    .aggregate<{ _id: { name: string } }>(
      [
        { $group: { _id: { userId: '$userId', name: '$name' }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
      ],
      { collation: { locale: 'pt', strength: 1 } }
    )
    .toArray()
  report.categoryNameConflicts = conflicts.map((c) => c._id.name)
  if (conflicts.length) log(`Categorias com nomes equivalentes (ajuste manualmente): ${report.categoryNameConflicts.join(', ')}`)

  if (!opts.apply) {
    log('\nSimulação concluída. Nada foi alterado. Rode com --apply para aplicar.')
    return report
  }

  log('\nAplicando...')

  const txResult = await transactions.updateMany({ ...legacyTransaction, date: { $type: 'date' } }, [
    {
      $set: {
        amountCents: toCents('$amount'),
        date: toDay('$date'),
        type: toType,
        categoryId: { $ifNull: ['$category', null] },
        recurringId: { $ifNull: ['$parentRecurringId', null] },
      },
    },
    { $unset: ['amount', 'category', 'categoryName', 'month', 'year', 'isRecurringGenerated', 'parentRecurringId'] },
  ])
  log(`  transações migradas: ${txResult.modifiedCount}`)

  const recResult = await recurring.updateMany(legacyRecurring, [
    {
      $set: {
        amountCents: toCents('$amount'),
        type: toType,
        categoryId: { $ifNull: ['$category', null] },
        startDate: { $cond: [{ $eq: [{ $type: '$startDate' }, 'date'] }, toDay('$startDate'), '$startDate'] },
        endDate: { $cond: [{ $eq: [{ $type: '$endDate' }, 'date'] }, toDay('$endDate'), null] },
      },
    },
    { $unset: ['amount', 'category', 'categoryName', 'lastAppliedMonth', 'lastAppliedDate'] },
  ])
  log(`  recorrências migradas: ${recResult.modifiedCount}`)

  await categories.updateMany({ transactionCount: { $exists: true } }, { $unset: { transactionCount: '' } })

  if (duplicates.length && opts.removeDuplicates) {
    // Mantém a transação mais antiga de cada grupo
    const toRemove = duplicates.flatMap((d) => [...d.ids].sort((a, b) => a.getTimestamp().getTime() - b.getTimestamp().getTime()).slice(1))
    const del = await transactions.deleteMany({ _id: { $in: toRemove } })
    report.duplicatesRemoved = del.deletedCount
    log(`  duplicatas removidas: ${del.deletedCount}`)
  } else if (duplicates.length) {
    log('  duplicatas mantidas (use --remove-duplicates para remover)')
  }

  if (opts.dropSummaries) {
    const exists = await db.listCollections({ name: 'monthlysummaries' }).hasNext()
    if (exists) await db.collection('monthlysummaries').drop()
    report.summariesDropped = exists
    log(`  coleção monthlysummaries ${exists ? 'removida' : 'não existia'}`)
  }

  // Índices
  await dropIndexIfExists(db, 'transactions', 'userId_1_month_1_year_1', log)
  await dropIndexIfExists(db, 'transactions', 'userId_1_category_1', log)
  await dropIndexIfExists(db, 'recurringtransactions', 'userId_1_startDate_1_endDate_1', log)
  await dropIndexIfExists(db, 'categories', 'userId_1_name_1', log)

  const indexes: [string, Document, Document][] = [
    ['transactions', { userId: 1, categoryId: 1 }, {}],
    [
      'transactions',
      { userId: 1, recurringId: 1, date: 1 },
      { unique: true, partialFilterExpression: { recurringId: { $type: 'objectId' } }, name: 'recurring_occurrence_unique' },
    ],
    ['categories', { userId: 1, name: 1 }, { unique: true, collation: { locale: 'pt', strength: 1 }, name: 'userId_name_ci' }],
  ]
  for (const [collection, keys, options] of indexes) {
    try {
      await db.collection(collection).createIndex(keys, options)
    } catch (err) {
      const msg = `Não foi possível criar índice em ${collection} ${JSON.stringify(keys)}: ${(err as Error).message}`
      report.indexWarnings.push(msg)
      log(`  AVISO: ${msg}`)
    }
  }

  log('Migração concluída.')
  return report
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('Defina MONGODB_URI no .env')

  await mongoose.connect(uri)
  const db = mongoose.connection.db!
  console.log(`Banco: ${db.databaseName}\n`)
  try {
    const report = await migrate(db, {
      apply: args.has('--apply'),
      removeDuplicates: args.has('--remove-duplicates'),
      dropSummaries: args.has('--drop-summaries'),
    })
    if (report.samples.length) console.log('\nExemplos de conversão:', JSON.stringify(report.samples, null, 2))
  } finally {
    await mongoose.disconnect()
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
