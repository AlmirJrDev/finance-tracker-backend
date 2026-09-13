import { Types, type PipelineStage } from 'mongoose'
import { Transaction } from '../models/Transaction'
import { Category } from '../models/Category'
import { daysInMonth, monthBounds, toDateStr, toMonthStr } from '../lib/dates'

/**
 * Resumos são calculados na hora a partir das transações.
 * Sem cache, o saldo nunca fica desatualizado e meses sem movimento
 * não quebram a continuidade (saldo inicial = tudo que veio antes).
 */

const isIncome = { $eq: ['$type', 'income'] }
const signedAmount = { $cond: [isIncome, '$amountCents', { $multiply: ['$amountCents', -1] }] }

export type DaySummary = {
  date: string
  incomeCents: number
  expenseCents: number
  balanceCents: number
  transactionCount: number
}

export type MonthTotals = {
  month: string
  initialBalanceCents: number
  incomeCents: number
  expenseCents: number
  resultCents: number
  finalBalanceCents: number
  transactionCount: number
  days: DaySummary[]
}

export type CategoryTotal = {
  categoryId: string | null
  name: string
  color: string
  icon: string | null
  incomeCents: number
  expenseCents: number
  transactionCount: number
}

type DailyRow = { _id: string; incomeCents: number; expenseCents: number; count: number }

async function balanceBefore(userId: Types.ObjectId, date: string): Promise<number> {
  const [row] = await Transaction.aggregate<{ total: number }>([
    { $match: { userId, date: { $lt: date } } },
    { $group: { _id: null, total: { $sum: signedAmount } } },
  ])
  return row?.total ?? 0
}

async function dailyTotals(userId: Types.ObjectId, from: string, to: string): Promise<Map<string, DailyRow>> {
  const rows = await Transaction.aggregate<DailyRow>([
    { $match: { userId, date: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: '$date',
        incomeCents: { $sum: { $cond: [isIncome, '$amountCents', 0] } },
        expenseCents: { $sum: { $cond: [isIncome, 0, '$amountCents'] } },
        count: { $sum: 1 },
      },
    },
  ])
  return new Map(rows.map((r) => [r._id, r]))
}

function buildMonth(ym: string, initialBalanceCents: number, daily: Map<string, DailyRow>): MonthTotals {
  const [year, month] = ym.split('-').map(Number)
  let balance = initialBalanceCents
  let incomeCents = 0
  let expenseCents = 0
  let transactionCount = 0

  const days: DaySummary[] = []
  for (let d = 1; d <= daysInMonth(year, month); d++) {
    const date = toDateStr(year, month, d)
    const row = daily.get(date)
    const inc = row?.incomeCents ?? 0
    const exp = row?.expenseCents ?? 0
    balance += inc - exp
    incomeCents += inc
    expenseCents += exp
    transactionCount += row?.count ?? 0
    days.push({ date, incomeCents: inc, expenseCents: exp, balanceCents: balance, transactionCount: row?.count ?? 0 })
  }

  return {
    month: ym,
    initialBalanceCents,
    incomeCents,
    expenseCents,
    resultCents: incomeCents - expenseCents,
    finalBalanceCents: balance,
    transactionCount,
    days,
  }
}

async function categoryTotals(userId: Types.ObjectId, from: string, to: string): Promise<CategoryTotal[]> {
  const pipeline: PipelineStage[] = [
    { $match: { userId, date: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: '$categoryId',
        incomeCents: { $sum: { $cond: [isIncome, '$amountCents', 0] } },
        expenseCents: { $sum: { $cond: [isIncome, 0, '$amountCents'] } },
        count: { $sum: 1 },
      },
    },
    { $sort: { expenseCents: -1, incomeCents: -1 } },
  ]
  const rows = await Transaction.aggregate<{
    _id: Types.ObjectId | null
    incomeCents: number
    expenseCents: number
    count: number
  }>(pipeline)

  const ids = rows.map((r) => r._id).filter((id): id is Types.ObjectId => id !== null)
  const categories = await Category.find({ _id: { $in: ids } }).lean()
  const byId = new Map(categories.map((c) => [c._id.toString(), c]))

  return rows.map((r) => {
    const cat = r._id ? byId.get(r._id.toString()) : undefined
    return {
      categoryId: cat ? cat._id.toString() : null,
      name: cat?.name ?? 'Sem categoria',
      color: cat?.color ?? '#9CA3AF',
      icon: cat?.icon ?? null,
      incomeCents: r.incomeCents,
      expenseCents: r.expenseCents,
      transactionCount: r.count,
    }
  })
}

export async function getMonthSummary(userId: string, ym: string) {
  const uid = new Types.ObjectId(userId)
  const { from, to } = monthBounds(ym)
  const [initial, daily, byCategory] = await Promise.all([
    balanceBefore(uid, from),
    dailyTotals(uid, from, to),
    categoryTotals(uid, from, to),
  ])
  return { ...buildMonth(ym, initial, daily), byCategory }
}

export async function getYearSummary(userId: string, year: number) {
  const uid = new Types.ObjectId(userId)
  const [initial, daily] = await Promise.all([
    balanceBefore(uid, `${year}-01-01`),
    dailyTotals(uid, `${year}-01-01`, `${year}-12-31`),
  ])

  const months: MonthTotals[] = []
  let balance = initial
  for (let m = 1; m <= 12; m++) {
    const month = buildMonth(toMonthStr(year, m), balance, daily)
    months.push(month)
    balance = month.finalBalanceCents
  }

  const incomeCents = months.reduce((s, m) => s + m.incomeCents, 0)
  const expenseCents = months.reduce((s, m) => s + m.expenseCents, 0)
  return {
    year,
    initialBalanceCents: initial,
    incomeCents,
    expenseCents,
    resultCents: incomeCents - expenseCents,
    finalBalanceCents: balance,
    months,
  }
}

/** Meses que têm pelo menos uma transação, do mais recente para o mais antigo. */
export async function getActiveMonths(userId: string) {
  const rows = await Transaction.aggregate<{ _id: string; count: number }>([
    { $match: { userId: new Types.ObjectId(userId) } },
    { $group: { _id: { $substrBytes: ['$date', 0, 7] }, count: { $sum: 1 } } },
    { $sort: { _id: -1 } },
  ])
  return rows.map((r) => ({ month: r._id, transactionCount: r.count }))
}
