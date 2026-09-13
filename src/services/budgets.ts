import { Types } from 'mongoose'
import { Budget, type BudgetDoc } from '../models/Budget'
import { Transaction } from '../models/Transaction'
import { monthBounds } from '../lib/dates'
import { categoryMap } from './categories'
import { isPending } from './summary'

export type BudgetLevel = 'ok' | 'warning' | 'exceeded'

export function budgetLevel(totalCents: number, amountCents: number, alertPercent: number): BudgetLevel {
  if (totalCents > amountCents) return 'exceeded'
  if (totalCents * 100 >= amountCents * alertPercent) return 'warning'
  return 'ok'
}

/** Orçamentos com o quanto já foi gasto (pago) e o que ainda está previsto (pendente) no mês. */
export async function getBudgetStatus(userId: string, month: string) {
  const uid = new Types.ObjectId(userId)
  const { from, to } = monthBounds(month)

  const [budgets, spending, categories] = await Promise.all([
    Budget.find({ userId: uid }).lean<BudgetDoc[]>(),
    Transaction.aggregate<{ _id: Types.ObjectId; paidCents: number; pendingCents: number }>([
      { $match: { userId: uid, type: 'expense', categoryId: { $ne: null }, date: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: '$categoryId',
          paidCents: { $sum: { $cond: [isPending, 0, '$amountCents'] } },
          pendingCents: { $sum: { $cond: [isPending, '$amountCents', 0] } },
        },
      },
    ]),
    categoryMap(userId),
  ])

  const spentBy = new Map(spending.map((s) => [s._id.toString(), s]))

  return budgets
    .filter((b) => categories.has(b.categoryId.toString()))
    .map((b) => {
      const categoryId = b.categoryId.toString()
      const spent = spentBy.get(categoryId)
      const paidCents = spent?.paidCents ?? 0
      const pendingCents = spent?.pendingCents ?? 0
      const totalCents = paidCents + pendingCents
      const alertPercent = b.alertPercent ?? 80
      return {
        categoryId,
        category: categories.get(categoryId)!,
        month,
        amountCents: b.amountCents,
        alertPercent,
        paidCents,
        pendingCents,
        totalCents,
        remainingCents: b.amountCents - totalCents,
        percent: Math.round((totalCents / b.amountCents) * 100),
        level: budgetLevel(totalCents, b.amountCents, alertPercent),
      }
    })
    .sort((a, b) => b.percent - a.percent)
}
