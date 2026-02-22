const { z } = require('zod')
const mongoose = require('mongoose')
const Transaction = require('../models/Transaction')
const Category = require('../models/Category')
const MonthlySummary = require('../models/MonthlySummary')
const { AppError } = require('../middleware/errorHandler')
const summaryService = require('../utils/summaryService')

// --- Schemas de validação (Zod) ---

const createSchema = z.object({
  date: z.string().refine((d) => !isNaN(Date.parse(d)), { message: 'Data inválida' }),
  description: z.string().trim().min(3).max(200),
  amount: z.number().positive().max(999999.99),
  type: z.enum(['entrada', 'saída']),
  category: z.string().optional().nullable(),
  note: z.string().max(500).trim().optional().nullable(),
})

const updateSchema = createSchema.partial()

// --- Helpers ---

async function resolveCategory(categoryId, userId) {
  if (!categoryId) return { category: null, categoryName: null }
  if (!mongoose.Types.ObjectId.isValid(categoryId)) {
    throw new AppError('ID de categoria inválido', 400, 'VALIDATION_ERROR')
  }
  const cat = await Category.findOne({ _id: categoryId, userId })
  if (!cat) throw new AppError('Categoria não encontrada', 404, 'NOT_FOUND')
  return { category: cat._id, categoryName: cat.name }
}

// --- Controllers ---

exports.list = async (req, res, next) => {
  try {
    const { year, month, type, category, page = 1, limit = 50 } = req.query
    const filter = { userId: req.userId }

    if (year) filter.year = parseInt(year)
    if (month) filter.month = parseInt(month)
    if (type) filter.type = type
    if (category) filter.category = category

    const skip = (parseInt(page) - 1) * parseInt(limit)
    const [transactions, total] = await Promise.all([
      Transaction.find(filter).sort({ date: -1 }).skip(skip).limit(parseInt(limit)).lean(),
      Transaction.countDocuments(filter),
    ])

    res.json({
      success: true,
      data: transactions,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) },
    })
  } catch (err) {
    next(err)
  }
}

exports.getById = async (req, res, next) => {
  try {
    const transaction = await Transaction.findOne({ _id: req.params.id, userId: req.userId }).lean()
    if (!transaction) throw new AppError('Transação não encontrada', 404, 'NOT_FOUND')
    res.json({ success: true, data: transaction })
  } catch (err) {
    next(err)
  }
}

exports.getByMonth = async (req, res, next) => {
  try {
    const { year, month } = req.params
    const transactions = await Transaction.find({
      userId: req.userId,
      year: parseInt(year),
      month: parseInt(month),
    })
      .sort({ date: 1 })
      .lean()
    res.json({ success: true, data: transactions })
  } catch (err) {
    next(err)
  }
}

exports.create = async (req, res, next) => {
  try {
    const body = createSchema.parse(req.body)
    const date = new Date(body.date)
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    if (date > tomorrow) throw new AppError('Data não pode ser no futuro', 400, 'VALIDATION_ERROR')

    const { category, categoryName } = await resolveCategory(body.category, req.userId)

    const transaction = await Transaction.create({
      ...body,
      date,
      month: date.getMonth() + 1,
      year: date.getFullYear(),
      userId: req.userId,
      amount: mongoose.Types.Decimal128.fromString(body.amount.toFixed(2)),
      category,
      categoryName,
    })

    // Atualizar resumo do mês em background
    summaryService.recalculate(req.userId, date.getFullYear(), date.getMonth() + 1).catch(() => {})

    res.status(201).json({ success: true, data: transaction })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0].message, 400, 'VALIDATION_ERROR'))
    }
    next(err)
  }
}

exports.update = async (req, res, next) => {
  try {
    const body = updateSchema.parse(req.body)
    const transaction = await Transaction.findOne({ _id: req.params.id, userId: req.userId })
    if (!transaction) throw new AppError('Transação não encontrada', 404, 'NOT_FOUND')

    const oldMonth = transaction.month
    const oldYear = transaction.year

    if (body.date) {
      const date = new Date(body.date)
      body.date = date
      body.month = date.getMonth() + 1
      body.year = date.getFullYear()
    }

    if (body.category !== undefined) {
      const { category, categoryName } = await resolveCategory(body.category, req.userId)
      body.category = category
      body.categoryName = categoryName
    }

    if (body.amount !== undefined) {
      body.amount = mongoose.Types.Decimal128.fromString(body.amount.toFixed(2))
    }

    Object.assign(transaction, body)
    await transaction.save()

    // Recalcular mês antigo e novo (se mudou)
    summaryService.recalculate(req.userId, oldYear, oldMonth).catch(() => {})
    if (body.year && (body.year !== oldYear || body.month !== oldMonth)) {
      summaryService.recalculate(req.userId, body.year, body.month).catch(() => {})
    }

    res.json({ success: true, data: transaction })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(err.errors[0].message, 400, 'VALIDATION_ERROR'))
    }
    next(err)
  }
}

exports.remove = async (req, res, next) => {
  try {
    const transaction = await Transaction.findOne({ _id: req.params.id, userId: req.userId })
    if (!transaction) throw new AppError('Transação não encontrada', 404, 'NOT_FOUND')

    const { year, month } = transaction
    await transaction.deleteOne()

    summaryService.recalculate(req.userId, year, month).catch(() => {})

    res.json({ success: true, message: 'Transação removida com sucesso.' })
  } catch (err) {
    next(err)
  }
}