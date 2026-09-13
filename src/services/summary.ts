import { Types, type PipelineStage } from 'mongoose'
import { Transaction } from '../models/Transaction'
import { Category } from '../models/Category'
import { daysInMonth, monthBounds, toDateStr, toMonthStr } from '../lib/dates'

/**
 * Resumos são calculados na hora a partir das transações.
 * Sem cache, o saldo nunca fica desatualizado e meses sem movimento
 * não quebram a continuidade (saldo inicial = tudo que veio antes).
 *
 * - Saldos "previstos" consideram todas as transações; os "pagos" só as confirmadas.
 * - Receitas, despesas e categorias consideram só kind "regular": transferências entre
 *   contas e ajustes de saldo mudam o saldo mas não são ganho nem gasto.
 * - Campos ausentes em documentos antigos: status = paid, kind = regular.
 */

export const isIncome = { $eq: ['$type', 'income'] }
export const isPending = { $eq: ['$status', 'pending'] }
export const isRegular = { $eq: [{ $ifNull: ['$kind', 'regular'] }, 'regular'] }
export const signedAmount = { $cond: [isIncome, '$amountCents', { $multiply: ['$amountCents', -1] }] }

const regularIncome = { $cond: [{ $and: [isRegular, isIncome] }, '$amountCents', 0] }
const regularExpense = { $cond: [{ $and: [isRegular, { $not: [isIncome] }] }, '$amountCents', 0] }

/** Filtro base: sempre do usuário, opcionalmente de uma conta. */
export type Scope = { userId: string; accountId?: string }

export function scopeMatch(scope: Scope): Record<string, unknown> {
  const match: Record<string, unknown> = { userId: new Types.ObjectId(scope.userId) }
  if (scope.accountId) match.accountId = new Types.ObjectId(scope.accountId)
  return match
}

export type DaySummary = {
  date: string
  incomeCents: number
  expenseCents: number
  /** Efeito líquido do dia no saldo (inclui transferências e ajustes) */
  netCents: number
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
  /** Transferências e ajustes do mês (efeito líquido no saldo) */
  otherMovementsCents: number
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

export type DailyRow = {
  _id: string
  incomeCents: number
  expenseCents: number
  pendingIncomeCents: number
  pendingExpenseCents: number
  netCents: number
  paidNetCents: number
  count: number
  pendingCount: number
}

export async function balanceBefore(scope: Scope, date: string): Promise<{ all: number; paid: number }> {
  const [row] = await Transaction.aggregate<{ all: number; paid: number }>([
    { $match: { ...scopeMatch(scope), date: { $lt: date } } },
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

export async function dailyTotals(scope: Scope, from: string, to: string): Promise<Map<string, DailyRow>> {
  const rows = await Transaction.aggregate<DailyRow>([
    { $match: { ...scopeMatch(scope), date: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: '$date',
        incomeCents: { $sum: regularIncome },
        expenseCents: { $sum: regularExpense },
        pendingIncomeCents: { $sum: { $cond: [isPending, regularIncome, 0] } },
        pendingExpenseCents: { $sum: { $cond: [isPending, regularExpense, 0] } },
        netCents: { $sum: signedAmount },
        paidNetCents: { $sum: { $cond: [isPending, 0, signedAmount] } },
        count: { $sum: 1 },
        pendingCount: { $sum: { $cond: [isPending, 1, 0] } },
      },
    },
  ])
  return new Map(rows.map((r) => [r._id, r]))
}

function buildMonth(ym: string, initial: { all: number; paid: number }, daily: Map<string, DailyRow>): MonthTotals {
  const [year, month] = ym.split('-').map(Number)
  let balance = initial.all
  let paidBalance = initial.paid
  const totals = { income: 0, expense: 0, pendingIncome: 0, pendingExpense: 0, net: 0, count: 0, pendingCount: 0 }

  const days: DaySummary[] = []
  for (let d = 1; d <= daysInMonth(year, month); d++) {
    const date = toDateStr(year, month, d)
    const row = daily.get(date)

    balance += row?.netCents ?? 0
    paidBalance += row?.paidNetCents ?? 0
    totals.income += row?.incomeCents ?? 0
    totals.expense += row?.expenseCents ?? 0
    totals.pendingIncome += row?.pendingIncomeCents ?? 0
    totals.pendingExpense += row?.pendingExpenseCents ?? 0
    totals.net += row?.netCents ?? 0
    totals.count += row?.count ?? 0
    totals.pendingCount += row?.pendingCount ?? 0

    days.push({
      date,
      incomeCents: row?.incomeCents ?? 0,
      expenseCents: row?.expenseCents ?? 0,
      netCents: row?.netCents ?? 0,
      balanceCents: balance,
      transactionCount: row?.count ?? 0,
      pendingCount: row?.pendingCount ?? 0,
    })
  }

  const resultCents = totals.income - totals.expense
  return {
    month: ym,
    initialBalanceCents: initial.all,
    incomeCents: totals.income,
    expenseCents: totals.expense,
    resultCents,
    finalBalanceCents: balance,
    paidIncomeCents: totals.income - totals.pendingIncome,
    paidExpenseCents: totals.expense - totals.pendingExpense,
    pendingIncomeCents: totals.pendingIncome,
    pendingExpenseCents: totals.pendingExpense,
    paidFinalBalanceCents: paidBalance,
    otherMovementsCents: totals.net - resultCents,
    transactionCount: totals.count,
    pendingCount: totals.pendingCount,
    days,
  }
}

async function categoryTotals(scope: Scope, from: string, to: string): Promise<CategoryTotal[]> {
  const pipeline: PipelineStage[] = [
    { $match: { ...scopeMatch(scope), date: { $gte: from, $lte: to }, kind: { $nin: ['transfer', 'adjustment'] } } },
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

export async function getMonthSummary(scope: Scope, ym: string) {
  const { from, to } = monthBounds(ym)
  const [initial, daily, byCategory] = await Promise.all([
    balanceBefore(scope, from),
    dailyTotals(scope, from, to),
    categoryTotals(scope, from, to),
  ])
  return { ...buildMonth(ym, initial, daily), byCategory }
}

export async function getYearSummary(scope: Scope, year: number) {
  const [initial, daily] = await Promise.all([
    balanceBefore(scope, `${year}-01-01`),
    dailyTotals(scope, `${year}-01-01`, `${year}-12-31`),
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
export async function getActiveMonths(scope: Scope) {
  const rows = await Transaction.aggregate<{ _id: string; count: number }>([
    { $match: scopeMatch(scope) },
    { $group: { _id: { $substrBytes: ['$date', 0, 7] }, count: { $sum: 1 } } },
    { $sort: { _id: -1 } },
  ])
  return rows.map((r) => ({ month: r._id, transactionCount: r.count }))
}
