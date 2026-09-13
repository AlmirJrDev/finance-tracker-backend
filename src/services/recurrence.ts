import { Types } from 'mongoose'
import { RecurringTransaction, type Frequency, type RecurringDoc } from '../models/RecurringTransaction'
import { Transaction } from '../models/Transaction'
import { daysInMonth, monthRange, parseMonth, toDateStr, weekday } from '../lib/dates'
import { badRequest, isDuplicateKeyError } from '../lib/errors'

export const MAX_APPLY_MONTHS = 24

type RecurrenceRule = {
  frequency: Frequency
  dayOfMonth?: number | null
  dayOfWeek?: number | null
  startDate: string
  endDate?: string | null
}

/** Datas (YYYY-MM-DD) em que a recorrência acontece dentro do mês. */
export function occurrencesInMonth(rule: RecurrenceRule, ym: string): string[] {
  const { year, month } = parseMonth(ym)
  const total = daysInMonth(year, month)
  let dates: string[] = []

  if (rule.frequency === 'monthly') {
    if (!rule.dayOfMonth) return []
    // Dia 31 em fevereiro vira o último dia do mês
    dates = [toDateStr(year, month, Math.min(rule.dayOfMonth, total))]
  } else {
    for (let d = 1; d <= total; d++) {
      const date = toDateStr(year, month, d)
      if (rule.frequency === 'daily' || weekday(date) === rule.dayOfWeek) dates.push(date)
    }
  }

  return dates.filter((d) => d >= rule.startDate && (!rule.endDate || d <= rule.endDate))
}

/**
 * Gera as transações das recorrências ativas no intervalo de meses.
 * Idempotente: o índice único (userId, recurringId, date) impede duplicatas,
 * então aplicar o mesmo mês várias vezes, em qualquer ordem, é seguro.
 */
export async function applyRecurring(
  userId: string,
  { from, to, ids }: { from: string; to: string; ids?: string[] }
): Promise<{ created: number; existing: number }> {
  if (from > to) throw badRequest('"from" deve ser anterior ou igual a "to"')
  const months = monthRange(from, to)
  if (months.length > MAX_APPLY_MONTHS) {
    throw badRequest(`Intervalo máximo de ${MAX_APPLY_MONTHS} meses`)
  }

  const uid = new Types.ObjectId(userId)
  const filter: Record<string, unknown> = { userId: uid, isActive: true }
  if (ids?.length) filter._id = { $in: ids.map((id) => new Types.ObjectId(id)) }

  const items = await RecurringTransaction.find(filter).lean<RecurringDoc[]>()
  const now = new Date()

  const ops = items.flatMap((r) =>
    months.flatMap((ym) =>
      occurrencesInMonth(r, ym).map((date) => ({
        updateOne: {
          filter: { userId: uid, recurringId: r._id, date },
          update: {
            $setOnInsert: {
              description: r.description,
              amountCents: r.amountCents,
              type: r.type,
              categoryId: r.categoryId ?? null,
              note: r.note,
              createdAt: now,
              updatedAt: now,
            },
          },
          upsert: true,
          timestamps: false,
        },
      }))
    )
  )

  if (ops.length === 0) return { created: 0, existing: 0 }

  let created = 0
  try {
    const result = await Transaction.bulkWrite(ops, { ordered: false })
    created = result.upsertedCount
  } catch (err) {
    // Duas aplicações simultâneas podem colidir no índice único; as demais operações seguem.
    if (!isDuplicateKeyError(err)) throw err
    const e = err as { result?: { upsertedCount?: number } }
    created = e.result?.upsertedCount ?? 0
  }

  return { created, existing: ops.length - created }
}
