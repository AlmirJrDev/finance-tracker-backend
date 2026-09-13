import { Router } from 'express'
import { z } from 'zod'
import { getActiveMonths, getMonthSummary, getYearSummary } from '../services/summary'
import { getProjection, MAX_PROJECTION_DAYS } from '../services/projection'
import { categoryMap } from '../services/categories'
import { MONTH_RE } from '../lib/dates'
import { asyncHandler, currentUserId, objectIdSchema, userToday } from '../lib/http'
import { Account } from '../models/Account'
import { notFound } from '../lib/errors'
import type { Request } from 'express'
import type { Scope } from '../services/summary'
import { toTransactionDTO } from './transactions'

const router = Router()

/** Escopo do resumo: todas as contas ou ?accountId=<conta do usuário>. */
async function scopeOf(req: Request): Promise<Scope> {
  const userId = currentUserId(req)
  const { accountId } = z.object({ accountId: objectIdSchema.optional() }).parse(req.query)
  if (accountId && !(await Account.exists({ _id: accountId, userId }))) throw notFound('Conta não encontrada')
  return { userId, accountId }
}

router.get(
  '/months',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await getActiveMonths(await scopeOf(req)) })
  })
)

router.get(
  '/month/:month',
  asyncHandler(async (req, res) => {
    const month = z.string().regex(MONTH_RE, 'Mês inválido (use AAAA-MM)').parse(req.params.month)
    res.json({ success: true, data: await getMonthSummary(await scopeOf(req), month) })
  })
)

router.get(
  '/year/:year',
  asyncHandler(async (req, res) => {
    const year = z.coerce.number().int().min(2000).max(2100).parse(req.params.year)
    res.json({ success: true, data: await getYearSummary(await scopeOf(req), year) })
  })
)

/** Saldo realizado hoje, saldo previsto dia a dia, contas atrasadas e próximos vencimentos. */
router.get(
  '/projection',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const { days } = z
      .object({ days: z.coerce.number().int().min(7).max(MAX_PROJECTION_DAYS).default(90) })
      .parse({ days: req.query.days })
    const scope = await scopeOf(req)

    const [projection, categories] = await Promise.all([getProjection(scope, userToday(req), days), categoryMap(userId)])
    const categoryOf = (id: string | null) => (id ? (categories.get(id) ?? null) : null)

    res.json({
      success: true,
      data: {
        ...projection,
        upcoming: [
          ...projection.upcoming.transactions.map((t) => ({ ...toTransactionDTO(t, categories), virtual: false })),
          ...projection.upcoming.virtual.map((v) => ({
            id: null,
            date: v.date,
            description: v.description,
            amountCents: v.amountCents,
            type: v.type,
            status: 'pending' as const,
            categoryId: v.categoryId,
            accountId: v.accountId,
            category: categoryOf(v.categoryId),
            recurringId: v.recurringId,
            virtual: true,
          })),
        ].sort((a, b) => a.date.localeCompare(b.date)),
      },
    })
  })
)

export default router
