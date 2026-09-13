import { Types, type PipelineStage } from 'mongoose'
import { Transaction } from '../models/Transaction'
import { Category } from '../models/Category'
import { daysInMonth, monthBounds, toDateStr, toMonthStr } from '../lib/dates'

/**
 * Resumos são calculados na hora a partir das transações.
 * Sem cache, o saldo nunca fica desatualizado e meses sem movimento
 * não quebram a continuidade (saldo inicial = tudo que veio antes).
 *
 * Os saldos "previstos" consideram todas as transações; os "pagos" só as confirmadas.
 * Transações sem status (anteriores à Fase 2) contam como pagas.
 */

export const isIncome = { $eq: ['$type', 'income'] }
export const isPending = { $eq: ['$status', 'pending'] }
export const signedAmount = { $cond: [isIncome, '$amountCents', { $multiply: ['$amountCents', -1] }] }

export type DaySummary = {
  date: string
  incomeCents: number
  expenseCents: number
  balanceCents: number
  transactionCount: number
  pendingCount: number
}

export type MonthTotals = {
  month: string
  initialBalanceCents: number
  incomeCents: number
  expenseCents: number
  resultCents: number
  finalBalanceCents: number
  paidIncomeCents: number
  paidExpenseCents: number
  pendingIncomeCents: number
  pendingExpenseCents: number
  /** Saldo no fim do mês considerando só o que foi pago */
  paidFinalBalanceCents: number
  transactionCount: number
  pendingCount: number
  days: DaySummary[]
}

export type CategoryTotal = {
  categoryId: string | null
  name: string
  color: string
  icon: string | null
  incomeCents: number
  expenseCents: number
  pendingExpenseCents: number
  transactionCount: number
}

type DailyRow = {
  _id: string
  incomeCents: number
  expenseCents: number
  pendingIncomeCents: number
  pendingExpenseCents: number
  count: number
  pendingCount: number
}

export async function balanceBefore(userId: Types.ObjectId, date: string): Promise<{ all: number; paid: number }> {
  const [row] = await Transaction.aggregate<{ all: number; paid: number }>([
    { $match: { userId, date: { $lt: date } } },
    {
      $group: {
        _id: null,
        all: { $sum: signedAmount },
        paid: { $sum: { $cond: [isPending, 0, signedAmount] } },
      },
    },
  ])
  return { all: row?.all ?? 0, paid: row?.paid ?? 0 }
}

export async function dailyTotals(userId: Types.ObjectId, from: string, to: string): Promise<Map<string, DailyRow>> {
  const rows = await Transaction.aggregate<DailyRow>([
    { $match: { userId, date: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: '$date',
        incomeCents: { $sum: { $cond: [isIncome, '$amountCents', 0] } },
        expenseCents: { $sum: { $cond: [isIncome, 0, '$amountCents'] } },
        pendingIncomeCents: { $sum: { $cond: [{ $and: [isIncome, isPending] }, '$amountCents', 0] } },
        pendingExpenseCents: {
          $sum: { $cond: [{ $and: [{ $not: [isIncome] }, isPending] }, '$amountCents', 0] },
        },
        count: { $sum: 1 },
        pendingCount: { $sum: { $cond: [isPending, 1, 0] } },
      },
    },
  ])
  return new Map(rows.map((r) => [r._id, r]))
}

function buildMonth(
  ym: string,
  initial: { all: number; paid: number },
  daily: Map<string, DailyRow>
): MonthTotals {
  const [year, month] = ym.split('-').map(Number)
  let balance = initial.all
  let paidBalance = initial.paid
  const totals = { income: 0, expense: 0, pendingIncome: 0, pendingExpense: 0, count: 0, pendingCount: 0 }

  const days: DaySummary[] = []
  for (let d = 1; d <= daysInMonth(year, month); d++) {
    const date = toDateStr(year, month, d)
    const row = daily.get(date)
    const inc = row?.incomeCents ?? 0
    const exp = row?.expenseCents ?? 0
    const pInc = row?.pendingIncomeCents ?? 0
    const pExp = row?.pendingExpenseCents ?? 0

    balance += inc - exp
    paidBalance += inc - pInc - (exp - pExp)
    totals.income += inc
    totals.expense += exp
    totals.pendingIncome += pInc
    totals.pendingExpense += pExp
    totals.count += row?.count ?? 0
    totals.pendingCount += row?.pendingCount ?? 0

    days.push({
      date,
      incomeCents: inc,
      expenseCents: exp,
      balanceCents: balance,
      transactionCount: row?.count ?? 0,
      pendingCount: row?.pendingCount ?? 0,
    })
  }

  return {
    month: ym,
    initialBalanceCents: initial.all,
    incomeCents: totals.income,
    expenseCents: totals.expense,
    resultCents: totals.income - totals.expense,
    finalBalanceCents: balance,
    paidIncomeCents: totals.income - totals.pendingIncome,
    paidExpenseCents: totals.expense - totals.pendingExpense,
    pendingIncomeCents: totals.pendingIncome,
    pendingExpenseCents: totals.pendingExpense,
    paidFinalBalanceCents: paidBalance,
    transactionCount: totals.count,
    pendingCount: totals.pendingCount,
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
        pendingExpenseCents: {
          $sum: { $cond: [{ $and: [{ $not: [isIncome] }, isPending] }, '$amountCents', 0] },
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { expenseCents: -1, incomeCents: -1 } },
  ]
  const rows = await Transaction.aggregate<{
    _id: Types.ObjectId | null
    incomeCents: number
    expenseCents: number
    pendingExpenseCents: number
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
      pendingExpenseCents: r.pendingExpenseCents,
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
  let carry = initial
  for (let m = 1; m <= 12; m++) {
    const month = buildMonth(toMonthStr(year, m), carry, daily)
    months.push(month)
    carry = { all: month.finalBalanceCents, paid: month.paidFinalBalanceCents }
  }

  const incomeCents = months.reduce((s, m) => s + m.incomeCents, 0)
  const expenseCents = months.reduce((s, m) => s + m.expenseCents, 0)
  return {
    year,
    initialBalanceCents: initial.all,
    incomeCents,
    expenseCents,
    resultCents: incomeCents - expenseCents,
    finalBalanceCents: carry.all,
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
