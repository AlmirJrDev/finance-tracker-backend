import { Types } from 'mongoose'
import { Account, type AccountDoc } from '../models/Account'
import { Transaction } from '../models/Transaction'
import { isDuplicateKeyError, notFound } from '../lib/errors'
import { monthBounds } from '../lib/dates'
import { isPending, signedAmount } from './summary'

export const DEFAULT_ACCOUNT_NAME = 'Conta principal'

/** Garante que o usuário tenha uma conta padrão e devolve o ID dela. Seguro em paralelo. */
export async function ensureDefaultAccount(userId: string | Types.ObjectId): Promise<Types.ObjectId> {
  const uid = new Types.ObjectId(String(userId))
  const existing = await Account.findOne({ userId: uid, isDefault: true }, { _id: 1 }).lean()
  if (existing) return existing._id

  try {
    const created = await Account.findOneAndUpdate(
      { userId: uid, isDefault: true },
      { $setOnInsert: { userId: uid, name: DEFAULT_ACCOUNT_NAME, type: 'checking', isDefault: true } },
      { upsert: true, new: true }
    ).lean()
    return created!._id
  } catch (err) {
    // Corrida entre duas requisições ou já existe uma conta com o mesmo nome
    if (!isDuplicateKeyError(err)) throw err
    const again = await Account.findOne({ userId: uid, isDefault: true }, { _id: 1 }).lean()
    if (again) return again._id
    const byName = await Account.findOneAndUpdate(
      { userId: uid, name: DEFAULT_ACCOUNT_NAME },
      { $set: { isDefault: true } },
      { new: true }
    )
      .collation({ locale: 'pt', strength: 1 })
      .lean()
    return byName!._id
  }
}

/** Conta informada (validando que é do usuário) ou a conta padrão. */
export async function resolveAccountId(userId: string, accountId?: string | null): Promise<Types.ObjectId> {
  if (!accountId) return ensureDefaultAccount(userId)
  const exists = await Account.exists({ _id: accountId, userId })
  if (!exists) throw notFound('Conta não encontrada')
  return new Types.ObjectId(accountId)
}

export type AccountDTO = {
  id: string
  name: string
  type: string
  color: string
  icon: string | null
  isDefault: boolean
  isArchived: boolean
  provider: { name: string; connectorName: string | null; importFrom: string | null; lastSyncAt: Date | null } | null
}

export function toAccountDTO(a: AccountDoc): AccountDTO {
  return {
    id: a._id.toString(),
    name: a.name,
    type: a.type ?? 'checking',
    color: a.color ?? '#10B981',
    icon: a.icon ?? null,
    isDefault: Boolean(a.isDefault),
    isArchived: Boolean(a.isArchived),
    provider: a.provider
      ? {
          name: a.provider.name,
          connectorName: a.provider.connectorName ?? null,
          importFrom: a.provider.importFrom ?? null,
          lastSyncAt: a.provider.lastSyncAt ?? null,
        }
      : null,
  }
}

/**
 * Saldo de cada conta: pago até hoje e previsto até o fim do mês atual
 * (inclui pendentes e atrasadas; lançamentos de meses futuros ficam de fora).
 */
export async function accountBalances(userId: string, today: string) {
  const { to: monthEnd } = monthBounds(today.slice(0, 7))
  const rows = await Transaction.aggregate<{ _id: Types.ObjectId; paid: number; all: number; count: number }>([
    { $match: { userId: new Types.ObjectId(userId) } },
    {
      $group: {
        _id: '$accountId',
        paid: {
          $sum: { $cond: [{ $and: [{ $not: [isPending] }, { $lte: ['$date', today] }] }, signedAmount, 0] },
        },
        all: { $sum: { $cond: [{ $lte: ['$date', monthEnd] }, signedAmount, 0] } },
        count: { $sum: 1 },
      },
    },
  ])
  return new Map(rows.map((r) => [r._id.toString(), { balanceCents: r.paid, projectedBalanceCents: r.all, transactionCount: r.count }]))
}

export async function accountMap(userId: string): Promise<Map<string, AccountDTO>> {
  const accounts = await Account.find({ userId }).lean<AccountDoc[]>()
  return new Map(accounts.map((a) => [a._id.toString(), toAccountDTO(a)]))
}
