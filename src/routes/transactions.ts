import { Router } from 'express'
import { z } from 'zod'
import { Transaction, TRANSACTION_TYPES, MAX_AMOUNT_CENTS, type TransactionDoc } from '../models/Transaction'
import { assertCategoryOwnership, categoryMap, type CategoryDTO } from '../services/categories'
import { addDays, isValidDate, monthBounds, MONTH_RE, todayIn } from '../lib/dates'
import { asyncHandler, currentUserId, objectIdSchema, parseId } from '../lib/http'
import { badRequest, notFound } from '../lib/errors'
import type { Request } from 'express'

const router = Router()

export const dateSchema = z.string().refine(isValidDate, 'Data inválida (use AAAA-MM-DD)')

const bodySchema = z.object({
  date: dateSchema,
  description: z.string().trim().min(2).max(200),
  amountCents: z.number().int('amountCents deve ser inteiro (centavos)').positive().max(MAX_AMOUNT_CENTS),
  type: z.enum(TRANSACTION_TYPES),
  categoryId: objectIdSchema.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
})

const listQuerySchema = z.object({
  month: z.string().regex(MONTH_RE, 'Mês inválido (use AAAA-MM)').optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  categoryId: objectIdSchema.optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
})

function assertDateInRange(req: Request, date: string) {
  const max = addDays(todayIn(req.user?.preferences?.timezone ?? undefined), 731)
  if (date < '2000-01-01' || date > max) throw badRequest('Data fora do intervalo permitido')
}

export function toTransactionDTO(t: TransactionDoc, categories: Map<string, CategoryDTO>) {
  const categoryId = t.categoryId ? t.categoryId.toString() : null
  return {
    id: t._id.toString(),
    date: t.date,
    description: t.description,
    amountCents: t.amountCents,
    type: t.type,
    categoryId,
    category: categoryId ? (categories.get(categoryId) ?? null) : null,
    note: t.note ?? null,
    recurringId: t.recurringId ? t.recurringId.toString() : null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const query = listQuerySchema.parse(req.query)

    const filter: Record<string, unknown> = { userId }
    const range: Record<string, string> = {}
    if (query.month) {
      const { from, to } = monthBounds(query.month)
      range.$gte = from
      range.$lte = to
    }
    if (query.from) range.$gte = query.from
    if (query.to) range.$lte = query.to
    if (Object.keys(range).length) filter.date = range
    if (query.type) filter.type = query.type
    if (query.categoryId) filter.categoryId = query.categoryId
    if (query.q) {
      const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      filter.description = { $regex: escaped, $options: 'i' }
    }

    const direction = query.sort === 'asc' ? 1 : -1
    const [items, total, categories] = await Promise.all([
      Transaction.find(filter)
        .sort({ date: direction, createdAt: direction })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean<TransactionDoc[]>(),
      Transaction.countDocuments(filter),
      categoryMap(userId),
    ])

    res.json({
      success: true,
      data: items.map((t) => toTransactionDTO(t, categories)),
      pagination: { page: query.page, limit: query.limit, total, pages: Math.ceil(total / query.limit) },
    })
  })
)

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const t = await Transaction.findOne({ _id: parseId(req.params.id), userId }).lean<TransactionDoc>()
    if (!t) throw notFound('Transação não encontrada')
    res.json({ success: true, data: toTransactionDTO(t, await categoryMap(userId)) })
  })
)

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const body = bodySchema.parse(req.body)
    assertDateInRange(req, body.date)
    await assertCategoryOwnership(userId, body.categoryId)

    const created = await Transaction.create({ ...body, userId })
    const t = created.toObject() as TransactionDoc
    res.status(201).json({ success: true, data: toTransactionDTO(t, await categoryMap(userId)) })
  })
)

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const body = bodySchema.partial().parse(req.body)
    const t = await Transaction.findOne({ _id: parseId(req.params.id), userId })
    if (!t) throw notFound('Transação não encontrada')

    if (body.date && body.date !== t.date) assertDateInRange(req, body.date)
    if (body.categoryId !== undefined) await assertCategoryOwnership(userId, body.categoryId)

    t.set(body)
    await t.save()
    res.json({ success: true, data: toTransactionDTO(t.toObject() as TransactionDoc, await categoryMap(userId)) })
  })
)

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const result = await Transaction.deleteOne({ _id: parseId(req.params.id), userId })
    if (result.deletedCount === 0) throw notFound('Transação não encontrada')
    res.json({ success: true, message: 'Transação removida.' })
  })
)

export default router
