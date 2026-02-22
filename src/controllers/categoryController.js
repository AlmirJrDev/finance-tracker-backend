const { z } = require('zod')
const Category = require('../models/Category')
const Transaction = require('../models/Transaction')
const RecurringTransaction = require('../models/RecurringTransaction')
const { AppError } = require('../middleware/errorHandler')

const DEFAULT_CATEGORIES = [
  { name: 'Salário', color: '#00C853', icon: '💰', isDefault: true },
  { name: 'Alimentação', color: '#FF6D00', icon: '🍽️', isDefault: true },
  { name: 'Transporte', color: '#2962FF', icon: '🚗', isDefault: true },
  { name: 'Saúde', color: '#D50000', icon: '🏥', isDefault: true },
  { name: 'Moradia', color: '#AA00FF', icon: '🏠', isDefault: true },
  { name: 'Lazer', color: '#FF6F00', icon: '🎮', isDefault: true },
  { name: 'Outros', color: '#6B7280', icon: '📦', isDefault: true },
]

const schema = z.object({
  name: z.string().trim().min(2).max(50),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().max(2).optional(),
  description: z.string().max(200).optional(),
})

exports.list = async (req, res, next) => {
  try {
    const categories = await Category.find({ userId: req.userId }).sort({ isDefault: -1, name: 1 }).lean()

    // Criar categorias padrão se usuário novo
    if (categories.length === 0) {
      const defaults = DEFAULT_CATEGORIES.map((c) => ({ ...c, userId: req.userId }))
      const created = await Category.insertMany(defaults)
      return res.json({ success: true, data: created })
    }

    res.json({ success: true, data: categories })
  } catch (err) {
    next(err)
  }
}

exports.create = async (req, res, next) => {
  try {
    const body = schema.parse(req.body)
    const category = await Category.create({ ...body, userId: req.userId })
    res.status(201).json({ success: true, data: category })
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(err.errors[0].message, 400, 'VALIDATION_ERROR'))
    next(err)
  }
}

exports.update = async (req, res, next) => {
  try {
    const body = schema.partial().parse(req.body)
    const category = await Category.findOne({ _id: req.params.id, userId: req.userId })
    if (!category) throw new AppError('Categoria não encontrada', 404, 'NOT_FOUND')

    Object.assign(category, body)
    await category.save()
    res.json({ success: true, data: category })
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(err.errors[0].message, 400, 'VALIDATION_ERROR'))
    next(err)
  }
}

exports.remove = async (req, res, next) => {
  try {
    const category = await Category.findOne({ _id: req.params.id, userId: req.userId })
    if (!category) throw new AppError('Categoria não encontrada', 404, 'NOT_FOUND')
    if (category.isDefault) throw new AppError('Não é possível remover categorias padrão', 403, 'FORBIDDEN')

    // Mover transações para "Outros"
    const outros = await Category.findOne({ userId: req.userId, name: 'Outros' })
    const outrosId = outros ? outros._id : null
    const outrosName = outros ? outros.name : null

    await Transaction.updateMany(
      { userId: req.userId, category: category._id },
      { category: outrosId, categoryName: outrosName }
    )
    await RecurringTransaction.updateMany(
      { userId: req.userId, category: category._id },
      { category: outrosId, categoryName: outrosName }
    )

    await category.deleteOne()
    res.json({ success: true, message: 'Categoria removida. Transações movidas para Outros.' })
  } catch (err) {
    next(err)
  }
}

exports.getStats = async (req, res, next) => {
  try {
    const { year, month } = req.params
    const stats = await Transaction.aggregate([
      {
        $match: {
          userId: req.user._id,
          year: parseInt(year),
          month: parseInt(month),
        },
      },
      {
        $group: {
          _id: { category: '$category', categoryName: '$categoryName', type: '$type' },
          total: { $sum: { $toDouble: '$amount' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { total: -1 } },
    ])

    res.json({ success: true, data: stats })
  } catch (err) {
    next(err)
  }
}