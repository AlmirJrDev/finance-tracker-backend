import { Router } from 'express'
import { Types } from 'mongoose'
import { z } from 'zod'
import {
  Transaction,
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
  MAX_AMOUNT_CENTS,
  type TransactionDoc,
} from '../models/Transaction'
import { assertCategoryOwnership, categoryMap, type CategoryDTO } from '../services/categories'
import { addDays, addMonthsToDate, isValidDate, monthBounds, MONTH_RE } from '../lib/dates'
import { asyncHandler, currentUserId, objectIdSchema, parseId, userToday } from '../lib/http'
import { badRequest, notFound } from '../lib/errors'
import type { Request } from 'express'

const router = Router()

export const MAX_INSTALLMENTS = 72

export const dateSchema = z.string().refine(isValidDate, 'Data inválida (use AAAA-MM-DD)')
const amountSchema = z.number().int('amountCents deve ser inteiro (centavos)').positive().max(MAX_AMOUNT_CENTS)

const bodySchema = z.object({
  date: dateSchema,
  description: z.string().trim().min(2).max(200),
  amountCents: amountSchema,
  type: z.enum(TRANSACTION_TYPES),
  categoryId: objectIdSchema.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  // Se omitido: pendente quando a data é futura, pago caso contrário
  status: z.enum(TRANSACTION_STATUSES).optional(),
})

const installmentsSchema = z.object({
  date: dateSchema,
  description: z.string().trim().min(2).max(200),
  totalAmountCents: amountSchema,
  installments: z.number().int().min(2).max(MAX_INSTALLMENTS),
  type: z.enum(TRANSACTION_TYPES).default('expense'),
  categoryId: objectIdSchema.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
})

const listQuerySchema = z.object({
  month: z.string().regex(MONTH_RE, 'Mês inválido (use AAAA-MM)').optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  status: z.enum(TRANSACTION_STATUSES).optional(),
  categoryId: objectIdSchema.optional(),
  q: z.string().trim().max(100).optional(),
  sort: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(500).default(50),
})

function assertDateInRange(req: Request, date: string) {
  const max = addDays(userToday(req), 731)
  if (date < '2000-01-01' || date > max) throw badRequest('Data fora do intervalo permitido')
}

const defaultStatus = (date: string, today: string) => (date > today ? 'pending' : 'paid')

export function toTransactionDTO(t: TransactionDoc, categories: Map<string, CategoryDTO>) {
  const categoryId = t.categoryId ? t.categoryId.toString() : null
  return {
    id: t._id.toString(),
    date: t.date,
    description: t.description,
    amountCents: t.amountCents,
    type: t.type,
    status: t.status ?? 'paid',
    categoryId,
    category: categoryId ? (categories.get(categoryId) ?? null) : null,
    note: t.note ?? null,
    recurringId: t.recurringId ? t.recurringId.toString() : null,
    installment: t.installment
      ? { groupId: t.installment.groupId.toString(), number: t.installment.number, total: t.installment.total }
      : null,
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
    // Documentos antigos sem status são pagos
    if (query.status) filter.status = query.status === 'paid' ? { $ne: 'pending' } : 'pending'
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

/** Compra parcelada: divide o total em N transações mensais (o resto dos centavos vai na 1ª). */
router.post(
  '/installments',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const body = installmentsSchema.parse(req.body)
    const today = userToday(req)
    const lastDate = addMonthsToDate(body.date, body.installments - 1)
    assertDateInRange(req, body.date)
    assertDateInRange(req, lastDate)
    if (body.totalAmountCents < body.installments) throw badRequest('Valor menor que o número de parcelas')
    await assertCategoryOwnership(userId, body.categoryId)

    const groupId = new Types.ObjectId()
    const base = Math.floor(body.totalAmountCents / body.installments)
    const remainder = body.totalAmountCents - base * body.installments

    const docs = Array.from({ length: body.installments }, (_, i) => {
      const date = addMonthsToDate(body.date, i)
      return {
        userId,
        date,
        description: body.description,
        amountCents: base + (i === 0 ? remainder : 0),
        type: body.type,
        categoryId: body.categoryId ?? null,
        note: body.note ?? undefined,
        status: defaultStatus(date, today),
        installment: { groupId, number: i + 1, total: body.installments },
      }
    })

    const created = await Transaction.insertMany(docs)
    const categories = await categoryMap(userId)
    res.status(201).json({
      success: true,
      data: created.map((t) => toTransactionDTO(t.toObject() as TransactionDoc, categories)),
    })
  })
)

/** Remove um parcelamento inteiro ou só as parcelas ainda pendentes (?onlyPending=true). */
router.delete(
  '/installments/:groupId',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const filter: Record<string, unknown> = { userId, 'installment.groupId': parseId(req.params.groupId) }
    if (req.query.onlyPending === 'true') filter.status = 'pending'

    const result = await Transaction.deleteMany(filter)
    if (result.deletedCount === 0) throw notFound('Parcelamento não encontrado')
    res.json({ success: true, data: { deletedCount: result.deletedCount } })
  })
)

/** Altera o status de várias transações de uma vez (ex.: "marcar atrasadas como pagas"). */
router.post(
  '/status',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const body = z
      .object({ ids: z.array(objectIdSchema).min(1).max(500), status: z.enum(TRANSACTION_STATUSES) })
      .parse(req.body)
    const result = await Transaction.updateMany({ userId, _id: { $in: body.ids } }, { $set: { status: body.status } })
    res.json({ success: true, data: { modifiedCount: result.modifiedCount } })
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

    const created = await Transaction.create({
      ...body,
      status: body.status ?? defaultStatus(body.date, userToday(req)),
      userId,
    })
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
