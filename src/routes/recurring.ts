import { Router } from 'express'
import { z } from 'zod'
import { RecurringTransaction, FREQUENCIES, type RecurringDoc } from '../models/RecurringTransaction'
import { MAX_AMOUNT_CENTS, TRANSACTION_TYPES } from '../models/Transaction'
import { assertCategoryOwnership, categoryMap, type CategoryDTO } from '../services/categories'
import { applyRecurring } from '../services/recurrence'
import { MONTH_RE } from '../lib/dates'
import { asyncHandler, currentUserId, objectIdSchema, parseId, userToday } from '../lib/http'
import { notFound } from '../lib/errors'
import { dateSchema } from './transactions'
import { resolveAccountId } from '../services/accounts'

const router = Router()

const baseSchema = z.object({
  description: z.string().trim().min(2).max(200),
  amountCents: z.number().int('amountCents deve ser inteiro (centavos)').positive().max(MAX_AMOUNT_CENTS),
  type: z.enum(TRANSACTION_TYPES),
  categoryId: objectIdSchema.nullable().optional(),
  accountId: objectIdSchema.nullable().optional(),
  frequency: z.enum(FREQUENCIES),
  dayOfMonth: z.number().int().min(1).max(31).nullable().optional(),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  isActive: z.boolean().default(true),
  autoConfirm: z.boolean().default(false),
  startDate: dateSchema,
  endDate: dateSchema.nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
})

const fullSchema = baseSchema.superRefine((v, ctx) => {
  if (v.frequency === 'monthly' && !v.dayOfMonth) {
    ctx.addIssue({ code: 'custom', path: ['dayOfMonth'], message: 'Obrigatório para frequência mensal' })
  }
  if (v.frequency === 'weekly' && (v.dayOfWeek === null || v.dayOfWeek === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['dayOfWeek'], message: 'Obrigatório para frequência semanal' })
  }
  if (v.endDate && v.endDate < v.startDate) {
    ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'Deve ser igual ou posterior à data inicial' })
  }
})

const applySchema = z.object({
  from: z.string().regex(MONTH_RE, 'Mês inválido (use AAAA-MM)'),
  to: z.string().regex(MONTH_RE, 'Mês inválido (use AAAA-MM)'),
  ids: z.array(objectIdSchema).optional(),
})

function toRecurringDTO(r: RecurringDoc, categories: Map<string, CategoryDTO>) {
  const categoryId = r.categoryId ? r.categoryId.toString() : null
  return {
    id: r._id.toString(),
    description: r.description,
    amountCents: r.amountCents,
    type: r.type,
    categoryId,
    category: categoryId ? (categories.get(categoryId) ?? null) : null,
    accountId: r.accountId ? r.accountId.toString() : null,
    frequency: r.frequency,
    dayOfMonth: r.frequency === 'monthly' ? (r.dayOfMonth ?? null) : null,
    dayOfWeek: r.frequency === 'weekly' ? (r.dayOfWeek ?? null) : null,
    isActive: r.isActive,
    autoConfirm: Boolean(r.autoConfirm),
    startDate: r.startDate,
    endDate: r.endDate ?? null,
    note: r.note ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const filter: Record<string, unknown> = { userId }
    if (req.query.active === 'true' || req.query.active === 'false') filter.isActive = req.query.active === 'true'

    const [items, categories] = await Promise.all([
      RecurringTransaction.find(filter).sort({ createdAt: -1 }).lean<RecurringDoc[]>(),
      categoryMap(userId),
    ])
    res.json({ success: true, data: items.map((r) => toRecurringDTO(r, categories)) })
  })
)

/** Gera as transações das recorrências ativas entre dois meses (inclusive). */
router.post(
  '/apply',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const body = applySchema.parse(req.body)
    const result = await applyRecurring(userId, { ...body, today: userToday(req) })
    res.json({
      success: true,
      data: result,
      message: `${result.created} transação(ões) criada(s), ${result.existing} já existia(m).`,
    })
  })
)

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const r = await RecurringTransaction.findOne({ _id: parseId(req.params.id), userId }).lean<RecurringDoc>()
    if (!r) throw notFound('Transação recorrente não encontrada')
    res.json({ success: true, data: toRecurringDTO(r, await categoryMap(userId)) })
  })
)

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const body = fullSchema.parse(req.body)
    await assertCategoryOwnership(userId, body.categoryId)
    const accountId = await resolveAccountId(userId, body.accountId)
    const created = await RecurringTransaction.create({ ...body, accountId, userId })
    res.status(201).json({
      success: true,
      data: toRecurringDTO(created.toObject() as RecurringDoc, await categoryMap(userId)),
    })
  })
)

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const item = await RecurringTransaction.findOne({ _id: parseId(req.params.id), userId })
    if (!item) throw notFound('Transação recorrente não encontrada')

    // Valida o estado final (atual + alterações), não só os campos enviados
    const current = toRecurringDTO(item.toObject() as RecurringDoc, new Map())
    const patch = baseSchema.partial().parse(req.body)
    const merged = fullSchema.parse({ ...current, ...patch })
    if (patch.categoryId !== undefined) await assertCategoryOwnership(userId, patch.categoryId)
    const accountId = patch.accountId !== undefined ? await resolveAccountId(userId, patch.accountId) : item.accountId

    item.set({
      description: merged.description,
      amountCents: merged.amountCents,
      type: merged.type,
      categoryId: merged.categoryId ?? null,
      accountId,
      frequency: merged.frequency,
      dayOfMonth: merged.dayOfMonth ?? null,
      dayOfWeek: merged.dayOfWeek ?? null,
      isActive: merged.isActive,
      autoConfirm: merged.autoConfirm,
      startDate: merged.startDate,
      endDate: merged.endDate ?? null,
      note: merged.note ?? undefined,
    })
    await item.save()
    res.json({ success: true, data: toRecurringDTO(item.toObject() as RecurringDoc, await categoryMap(userId)) })
  })
)

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const result = await RecurringTransaction.deleteOne({ _id: parseId(req.params.id), userId })
    if (result.deletedCount === 0) throw notFound('Transação recorrente não encontrada')
    // As transações já geradas continuam no histórico.
    res.json({ success: true, message: 'Transação recorrente removida.' })
  })
)

export default router
