import { timingSafeEqual } from 'node:crypto'
import { Router, type Request } from 'express'
import { env } from '../config/env'
import { User } from '../models/User'
import { RecurringTransaction } from '../models/RecurringTransaction'
import { applyRecurring, confirmDueOccurrences } from '../services/recurrence'
import { addMonths, todayIn } from '../lib/dates'
import { AppError } from '../lib/errors'
import { asyncHandler } from '../lib/http'
import { logger } from '../lib/logger'

const router = Router()

function assertCronSecret(req: Request) {
  const secret = env().CRON_SECRET
  if (!secret) throw new AppError(404, 'NOT_FOUND', 'Endpoint não encontrado.')

  // A Vercel envia "Authorization: Bearer <CRON_SECRET>"
  const received = Buffer.from(req.headers.authorization ?? '')
  const expected = Buffer.from(`Bearer ${secret}`)
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new AppError(401, 'UNAUTHORIZED', 'Não autorizado.')
  }
}

/**
 * Executado diariamente: gera as ocorrências do mês atual e do próximo para todas as
 * recorrências ativas e confirma as que têm confirmação automática e já venceram.
 */
router.get(
  '/recurring',
  asyncHandler(async (req, res) => {
    assertCronSecret(req)

    const userIds = await RecurringTransaction.distinct('userId', { isActive: true })
    const users = await User.find({ _id: { $in: userIds } }, { preferences: 1 }).lean()

    let created = 0
    let confirmed = 0
    const failures: string[] = []

    for (const user of users) {
      const userId = user._id.toString()
      const today = todayIn(user.preferences?.timezone ?? undefined)
      const month = today.slice(0, 7)
      try {
        const applied = await applyRecurring(userId, { from: month, to: addMonths(month, 1), today })
        created += applied.created
        confirmed += await confirmDueOccurrences(userId, today)
      } catch (err) {
        failures.push(userId)
        logger.error('Falha no cron de recorrências', { userId, error: String(err) })
      }
    }

    logger.info('Cron de recorrências concluído', { users: users.length, created, confirmed, failures: failures.length })
    res.json({ success: true, data: { users: users.length, created, confirmed, failures: failures.length } })
  })
)

export default router
