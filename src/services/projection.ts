import { Types } from 'mongoose'
import { Transaction, type TransactionDoc } from '../models/Transaction'
import { addDays } from '../lib/dates'
import { balanceBefore, dailyTotals, isIncome } from './summary'
import { virtualOccurrences } from './recurrence'

export const MAX_PROJECTION_DAYS = 366
export const UPCOMING_DAYS = 7

export type ProjectionPoint = { date: string; balanceCents: number }

/**
 * Projeção do saldo a partir de hoje.
 *
 * - Saldo realizado: só transações pagas até hoje.
 * - Saldo previsto: todas as transações (pagas e pendentes, inclusive atrasadas)
 *   + ocorrências de recorrências ativas que ainda não foram aplicadas.
 */
export async function getProjection(userId: string, today: string, days: number) {
  const uid = new Types.ObjectId(userId)
  const tomorrow = addDays(today, 1)
  const end = addDays(today, days)

  const [before, daily, virtuals, overdueRows, upcomingDocs] = await Promise.all([
    balanceBefore(uid, tomorrow),
    dailyTotals(uid, tomorrow, end),
    virtualOccurrences(userId, tomorrow, end),
    Transaction.aggregate<{ count: number; incomeCents: number; expenseCents: number }>([
      { $match: { userId: uid, status: 'pending', date: { $lt: today } } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          incomeCents: { $sum: { $cond: [isIncome, '$amountCents', 0] } },
          expenseCents: { $sum: { $cond: [isIncome, 0, '$amountCents'] } },
        },
      },
    ]),
    Transaction.find({ userId: uid, status: 'pending', date: { $gte: today, $lte: addDays(today, UPCOMING_DAYS) } })
      .sort({ date: 1, createdAt: 1 })
      .limit(50)
      .lean<TransactionDoc[]>(),
  ])

  const virtualByDate = new Map<string, number>()
  for (const v of virtuals) {
    const signed = v.type === 'income' ? v.amountCents : -v.amountCents
    virtualByDate.set(v.date, (virtualByDate.get(v.date) ?? 0) + signed)
  }

  let balance = before.all
  const points: ProjectionPoint[] = [{ date: today, balanceCents: balance }]
  let lowest = points[0]
  let firstNegativeDate: string | null = balance < 0 ? today : null

  for (let date = tomorrow; date <= end; date = addDays(date, 1)) {
    const row = daily.get(date)
    balance += (row?.incomeCents ?? 0) - (row?.expenseCents ?? 0) + (virtualByDate.get(date) ?? 0)
    const point = { date, balanceCents: balance }
    points.push(point)
    if (balance < lowest.balanceCents) lowest = point
    if (balance < 0 && !firstNegativeDate) firstNegativeDate = date
  }

  const overdue = overdueRows[0] ?? { count: 0, incomeCents: 0, expenseCents: 0 }
  const upcomingLimit = addDays(today, UPCOMING_DAYS)

  return {
    today,
    days,
    realizedBalanceCents: before.paid,
    projectedTodayCents: before.all,
    endBalanceCents: balance,
    lowest,
    firstNegativeDate,
    overdue: { count: overdue.count, incomeCents: overdue.incomeCents, expenseCents: overdue.expenseCents },
    upcoming: {
      transactions: upcomingDocs,
      virtual: virtuals.filter((v) => v.date <= upcomingLimit),
    },
    points,
  }
}
