import { Types } from 'mongoose'
import { Transaction } from '../models/Transaction'
import { User } from '../models/User'
import { BankConnection } from '../models/BankConnection'

/** A partir de quantos dias sem lançar os dados são considerados parados */
export const STALE_AFTER_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Quão atualizados estão os dados do usuário.
 * Atividade = última alteração feita pelo usuário ou último lançamento manual criado
 * (o que for mais recente). Lançamentos gerados por recorrência, ajustes e importações
 * automáticas não contam: eles acontecem mesmo sem o usuário usar o app.
 */
export async function getFreshness(userId: string, now = new Date()) {
  const uid = new Types.ObjectId(userId)
  const [user, lastManual, transactionCount, lastBankSync] = await Promise.all([
    User.findById(uid, { lastActivityAt: 1 }).lean(),
    Transaction.findOne(
      { userId: uid, recurringId: null, kind: { $ne: 'adjustment' }, 'external.id': { $exists: false } },
      { createdAt: 1, date: 1 }
    )
      .sort({ createdAt: -1 })
      .lean(),
    Transaction.countDocuments({ userId: uid }),
    // Com o banco sincronizando sozinho, os dados não ficam parados mesmo sem lançar à mão
    BankConnection.findOne({ userId: uid, lastSyncError: null }, { lastSyncAt: 1 }).sort({ lastSyncAt: -1 }).lean(),
  ])

  const candidates = [user?.lastActivityAt, lastManual?.createdAt, lastBankSync?.lastSyncAt].filter((d): d is Date => Boolean(d)).map((d) => new Date(d))
  const lastActivityAt = candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))) : null
  const daysSinceActivity = lastActivityAt ? Math.floor((now.getTime() - lastActivityAt.getTime()) / DAY_MS) : null

  return {
    hasData: transactionCount > 0,
    lastActivityAt,
    lastManualEntryDate: lastManual?.date ?? null,
    daysSinceActivity,
    staleAfterDays: STALE_AFTER_DAYS,
    // Usuário sem dados não tem o que ficar desatualizado
    stale: transactionCount > 0 && daysSinceActivity !== null && daysSinceActivity >= STALE_AFTER_DAYS,
  }
}
