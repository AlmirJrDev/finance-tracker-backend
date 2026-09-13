import { Router } from 'express'
import { z } from 'zod'
import { getActiveMonths, getMonthSummary, getYearSummary } from '../services/summary'
import { MONTH_RE } from '../lib/dates'
import { asyncHandler, currentUserId } from '../lib/http'

const router = Router()

router.get(
  '/months',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await getActiveMonths(currentUserId(req)) })
  })
)

router.get(
  '/month/:month',
  asyncHandler(async (req, res) => {
    const month = z.string().regex(MONTH_RE, 'Mês inválido (use AAAA-MM)').parse(req.params.month)
    res.json({ success: true, data: await getMonthSummary(currentUserId(req), month) })
  })
)

router.get(
  '/year/:year',
  asyncHandler(async (req, res) => {
    const year = z.coerce.number().int().min(2000).max(2100).parse(req.params.year)
    res.json({ success: true, data: await getYearSummary(currentUserId(req), year) })
  })
)

export default router
