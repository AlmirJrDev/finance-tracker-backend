import { Router } from 'express'
import { z } from 'zod'
import { Category, type CategoryDoc } from '../models/Category'
import { Transaction } from '../models/Transaction'
import { RecurringTransaction } from '../models/RecurringTransaction'
import { ensureDefaultCategories, FALLBACK_CATEGORY, toCategoryDTO } from '../services/categories'
import { asyncHandler, currentUserId, parseId } from '../lib/http'
import { AppError, notFound } from '../lib/errors'

const router = Router()

const bodySchema = z.object({
  name: z.string().trim().min(2).max(50),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Cor inválida (use #RRGGBB)').optional(),
  icon: z.string().trim().max(16).nullable().optional(),
  description: z.string().trim().max(200).nullable().optional(),
})

async function listCategories(userId: string) {
  return Category.find({ userId }).sort({ isDefault: -1, name: 1 }).collation({ locale: 'pt' }).lean<CategoryDoc[]>()
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    let categories = await listCategories(userId)
    if (categories.length === 0) {
      await ensureDefaultCategories(userId)
      categories = await listCategories(userId)
    }
    res.json({ success: true, data: categories.map(toCategoryDTO) })
  })
)

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const body = bodySchema.parse(req.body)
    const created = await Category.create({ ...body, userId })
    res.status(201).json({ success: true, data: toCategoryDTO(created.toObject() as CategoryDoc) })
  })
)

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const body = bodySchema.partial().parse(req.body)
    const category = await Category.findOne({ _id: parseId(req.params.id), userId })
    if (!category) throw notFound('Categoria não encontrada')

    category.set(body)
    await category.save()
    // Transações guardam só o ID, então renomear reflete em todo o histórico.
    res.json({ success: true, data: toCategoryDTO(category.toObject() as CategoryDoc) })
  })
)

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const category = await Category.findOne({ _id: parseId(req.params.id), userId })
    if (!category) throw notFound('Categoria não encontrada')
    if (category.isDefault) throw new AppError(403, 'FORBIDDEN', 'Não é possível remover categorias padrão.')

    const fallback = await Category.findOne({ userId, isDefault: true, name: FALLBACK_CATEGORY })
    const fallbackId = fallback?._id ?? null

    const [moved] = await Promise.all([
      Transaction.updateMany({ userId, categoryId: category._id }, { categoryId: fallbackId }),
      RecurringTransaction.updateMany({ userId, categoryId: category._id }, { categoryId: fallbackId }),
    ])
    await category.deleteOne()

    res.json({
      success: true,
      message: `Categoria removida. ${moved.modifiedCount} transação(ões) movida(s) para ${fallback ? FALLBACK_CATEGORY : 'sem categoria'}.`,
      data: { movedTo: fallbackId ? fallbackId.toString() : null, movedCount: moved.modifiedCount },
    })
  })
)

export default router
