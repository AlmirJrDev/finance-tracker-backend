import { Router } from 'express'
import { z } from 'zod'
import { Budget } from '../models/Budget'
import { MAX_AMOUNT_CENTS } from '../models/Transaction'
import { assertCategoryOwnership } from '../services/categories'
import { getBudgetStatus } from '../services/budgets'
import { MONTH_RE } from '../lib/dates'
import { asyncHandler, currentUserId, parseId, userToday } from '../lib/http'
import { notFound } from '../lib/errors'

const router = Router()

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { month } = z
      .object({ month: z.string().regex(MONTH_RE, 'Mês inválido (use AAAA-MM)').optional() })
      .parse(req.query)
    const data = await getBudgetStatus(currentUserId(req), month ?? userToday(req).slice(0, 7))
    res.json({ success: true, data })
  })
)

/** Cria ou atualiza o orçamento de uma categoria. */
router.put(
  '/:categoryId',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const categoryId = parseId(req.params.categoryId)
    const body = z
      .object({
        amountCents: z.number().int('amountCents deve ser inteiro (centavos)').positive().max(MAX_AMOUNT_CENTS),
        alertPercent: z.number().int().min(1).max(100).optional(),
      })
      .parse(req.body)
    await assertCategoryOwnership(userId, categoryId)

    const budget = await Budget.findOneAndUpdate(
      { userId, categoryId },
      { $set: body },
      { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
    ).lean()

    res.json({
      success: true,
      data: { categoryId, amountCents: budget!.amountCents, alertPercent: budget!.alertPercent ?? 80 },
    })
  })
)

router.delete(
  '/:categoryId',
  asyncHandler(async (req, res) => {
    const result = await Budget.deleteOne({ userId: currentUserId(req), categoryId: parseId(req.params.categoryId) })
    if (result.deletedCount === 0) throw notFound('Orçamento não encontrado')
    res.json({ success: true, message: 'Orçamento removido.' })
  })
)

export default router
