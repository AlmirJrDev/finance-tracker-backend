import { Types } from 'mongoose'
import { RecurringTransaction, type Frequency, type RecurringDoc } from '../models/RecurringTransaction'
import { Transaction, type TransactionStatus } from '../models/Transaction'
import { daysInMonth, monthRange, parseMonth, toDateStr, weekday } from '../lib/dates'
import { badRequest, isDuplicateKeyError } from '../lib/errors'
import { ensureDefaultAccount } from './accounts'
import type { Scope } from './summary'

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
 * Status de uma ocorrência gerada. O app não inventa histórico: sem confirmação automática,
 * toda ocorrência nasce pendente ("a confirmar"), inclusive as de datas que já passaram
 * (ex.: geradas enquanto o usuário não usava o app). Com confirmação automática (salário,
 * débito automático), vira paga quando a data chega.
 */
export function occurrenceStatus(date: string, today: string, autoConfirm: boolean): TransactionStatus {
  return autoConfirm && date <= today ? 'paid' : 'pending'
}

/**
 * Gera as transações das recorrências ativas no intervalo de meses.
 * Idempotente: o índice único (userId, recurringId, date) impede duplicatas,
 * então aplicar o mesmo mês várias vezes, em qualquer ordem, é seguro.
 */
export async function applyRecurring(
  userId: string,
  { from, to, ids, today }: { from: string; to: string; ids?: string[]; today: string }
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
  // bulkWrite não passa pela validação do schema: garante a conta aqui
  const fallbackAccountId = items.some((r) => !r.accountId) ? await ensureDefaultAccount(uid) : null

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
              accountId: (r.accountId ?? fallbackAccountId)!,
              kind: 'regular' as const,
              note: r.note,
              status: occurrenceStatus(date, today, Boolean(r.autoConfirm)),
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

/** Marca como pagas as ocorrências pendentes de recorrências com confirmação automática que já venceram. */
export async function confirmDueOccurrences(userId: string, today: string): Promise<number> {
  const uid = new Types.ObjectId(userId)
  const autoIds = await RecurringTransaction.find({ userId: uid, autoConfirm: true }).distinct('_id')
  if (autoIds.length === 0) return 0

  const result = await Transaction.updateMany(
    { userId: uid, recurringId: { $in: autoIds }, status: 'pending', date: { $lte: today } },
    { $set: { status: 'paid' } }
  )
  return result.modifiedCount
}

export type VirtualOccurrence = {
  recurringId: string
  date: string
  description: string
  amountCents: number
  type: 'income' | 'expense'
  categoryId: string | null
  accountId: string | null
}

/**
 * Ocorrências que as recorrências ativas vão gerar entre from e to (datas) e que ainda
 * não existem como transação. Usado na projeção de saldo sem precisar aplicar nada.
 */
export async function virtualOccurrences(scope: Scope, from: string, to: string): Promise<VirtualOccurrence[]> {
  const uid = new Types.ObjectId(scope.userId)
  const ruleFilter: Record<string, unknown> = { userId: uid, isActive: true }
  if (scope.accountId) ruleFilter.accountId = new Types.ObjectId(scope.accountId)
  const items = await RecurringTransaction.find(ruleFilter).lean<RecurringDoc[]>()
  if (items.length === 0) return []

  const existing = await Transaction.find(
    { userId: uid, recurringId: { $in: items.map((r) => r._id) }, date: { $gte: from, $lte: to } },
    { recurringId: 1, date: 1 }
  ).lean()
  const taken = new Set(existing.map((t) => `${t.recurringId}|${t.date}`))

  const months = monthRange(from.slice(0, 7), to.slice(0, 7))
  return items.flatMap((r) =>
    months.flatMap((ym) =>
      occurrencesInMonth(r, ym)
        .filter((date) => date >= from && date <= to && !taken.has(`${r._id}|${date}`))
        .map((date) => ({
          recurringId: r._id.toString(),
          date,
          description: r.description,
          amountCents: r.amountCents,
          type: r.type,
          categoryId: r.categoryId ? r.categoryId.toString() : null,
          accountId: r.accountId ? r.accountId.toString() : null,
        }))
    )
  )
}
