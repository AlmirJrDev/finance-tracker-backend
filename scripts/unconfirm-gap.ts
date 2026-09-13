/**
 * Volta para "a confirmar" as ocorrências recorrentes marcadas como pagas num período em
 * que o usuário não usou o app (ex.: pela migração ou por versões antigas que marcavam
 * datas passadas como pagas). Recorrências com confirmação automática não são alteradas.
 *
 *   npm run unconfirm-gap -- --email=voce@exemplo.com                  -> simulação
 *   npm run unconfirm-gap -- --email=voce@exemplo.com --since=2026-02-24 --apply
 *
 * Sem --since, usa a data do último lançamento manual do usuário.
 */
import 'dotenv/config'
import mongoose from 'mongoose'
import type { Db, ObjectId } from 'mongodb'
import { todayIn } from '../src/lib/dates'

export type UnconfirmOptions = { userId: ObjectId; since?: string; today: string; apply: boolean }

export async function unconfirmGap(db: Db, { userId, since, today, apply }: UnconfirmOptions) {
  const transactions = db.collection('transactions')

  let from = since
  if (!from) {
    const lastManual = await transactions
      .find({ userId, recurringId: null, kind: { $ne: 'adjustment' }, 'external.id': { $exists: false } })
      .sort({ date: -1 })
      .limit(1)
      .next()
    from = lastManual?.date
  }
  if (!from) return { since: null, count: 0, byRecurring: [] as { description: string; count: number; totalCents: number }[] }

  const autoConfirmIds = await db.collection('recurringtransactions').distinct('_id', { userId, autoConfirm: true })
  const filter = {
    userId,
    recurringId: { $type: 'objectId', $nin: autoConfirmIds },
    kind: { $nin: ['transfer', 'adjustment'] },
    status: { $ne: 'pending' },
    date: { $gt: from, $lte: today },
  }

  const byRecurring = await transactions
    .aggregate<{ description: string; count: number; totalCents: number }>([
      { $match: filter },
      { $group: { _id: '$recurringId', description: { $first: '$description' }, count: { $sum: 1 }, totalCents: { $sum: '$amountCents' } } },
      { $project: { _id: 0, description: 1, count: 1, totalCents: 1 } },
      { $sort: { description: 1 } },
    ])
    .toArray()
  const count = byRecurring.reduce((s, r) => s + r.count, 0)

  if (apply && count > 0) {
    await transactions.updateMany(filter, { $set: { status: 'pending' } })
  }
  return { since: from, count, byRecurring }
}

async function main() {
  const args: Record<string, string | true> = Object.fromEntries(
    process.argv.slice(2).map((a): [string, string | true] => {
      const [k, v] = a.replace(/^--/, '').split('=')
      return [k, v ?? true]
    })
  )
  if (!args.email) throw new Error('Informe --email=<e-mail do usuário>')
  if (!process.env.MONGODB_URI) throw new Error('Defina MONGODB_URI no .env')

  await mongoose.connect(process.env.MONGODB_URI)
  const db = mongoose.connection.db!
  try {
    const user = await db.collection('users').findOne({ email: String(args.email).toLowerCase() })
    if (!user) throw new Error('Usuário não encontrado')
    const result = await unconfirmGap(db, {
      userId: user._id,
      since: typeof args.since === 'string' ? args.since : undefined,
      today: todayIn('America/Sao_Paulo'),
      apply: args.apply === true,
    })
    console.log(`Banco: ${db.databaseName} | usuário: ${user.name}`)
    console.log(`Ocorrências pagas depois de ${result.since}: ${result.count}`)
    console.table(result.byRecurring.map((r) => ({ recorrência: r.description, ocorrências: r.count, total: (r.totalCents / 100).toFixed(2) })))
    console.log(args.apply ? 'Aplicado: agora estão "a confirmar".' : 'Simulação. Rode com --apply para aplicar.')
  } finally {
    await mongoose.disconnect()
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message ?? err)
    process.exit(1)
  })
}
