const { z } = require('zod')
const mongoose = require('mongoose')
const RecurringTransaction = require('../models/RecurringTransaction')
const Transaction = require('../models/Transaction')
const Category = require('../models/Category')
const { AppError } = require('../middleware/errorHandler')
const summaryService = require('../utils/summaryService')

const schema = z.object({
  description: z.string().trim().min(3).max(200),
  amount: z.number().positive().max(999999.99),
  type: z.enum(['entrada', 'saída']),
  category: z.string().optional().nullable(),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  dayOfMonth: z.number().min(1).max(31).optional().nullable(),
  dayOfWeek: z.number().min(0).max(6).optional().nullable(),
  isActive: z.boolean().default(true),
  startDate: z.string().refine((d) => !isNaN(Date.parse(d))),
  endDate: z.string().refine((d) => !isNaN(Date.parse(d))).optional().nullable(),
  note: z.string().max(500).optional().nullable(),
})

async function resolveCategory(categoryId, userId) {
  if (!categoryId) return { category: null, categoryName: null }
  const cat = await Category.findOne({ _id: categoryId, userId })
  if (!cat) throw new AppError('Categoria não encontrada', 404, 'NOT_FOUND')
  return { category: cat._id, categoryName: cat.name }
}

exports.list = async (req, res, next) => {
  try {
    const filter = { userId: req.userId }
    if (req.query.active !== undefined) filter.isActive = req.query.active === 'true'

    const items = await RecurringTransaction.find(filter).sort({ createdAt: -1 }).lean()
    res.json({ success: true, data: items })
  } catch (err) { next(err) }
}

exports.getById = async (req, res, next) => {
  try {
    const item = await RecurringTransaction.findOne({ _id: req.params.id, userId: req.userId }).lean()
    if (!item) throw new AppError('Transação recorrente não encontrada', 404, 'NOT_FOUND')
    res.json({ success: true, data: item })
  } catch (err) { next(err) }
}

exports.create = async (req, res, next) => {
  try {
    const body = schema.parse(req.body)

    if (body.frequency === 'monthly' && !body.dayOfMonth) {
      throw new AppError('dayOfMonth é obrigatório para frequência mensal', 400, 'VALIDATION_ERROR')
    }
    if (body.frequency === 'weekly' && body.dayOfWeek == null) {
      throw new AppError('dayOfWeek é obrigatório para frequência semanal', 400, 'VALIDATION_ERROR')
    }
    if (body.endDate && new Date(body.endDate) <= new Date(body.startDate)) {
      throw new AppError('endDate deve ser posterior a startDate', 400, 'VALIDATION_ERROR')
    }

    const { category, categoryName } = await resolveCategory(body.category, req.userId)
    const item = await RecurringTransaction.create({
      ...body,
      startDate: new Date(body.startDate),
      endDate: body.endDate ? new Date(body.endDate) : null,
      amount: mongoose.Types.Decimal128.fromString(body.amount.toFixed(2)),
      userId: req.userId,
      category,
      categoryName,
    })

    res.status(201).json({ success: true, data: item })
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(err.errors[0].message, 400, 'VALIDATION_ERROR'))
    next(err)
  }
}

exports.update = async (req, res, next) => {
  try {
    const body = schema.partial().parse(req.body)
    const item = await RecurringTransaction.findOne({ _id: req.params.id, userId: req.userId })
    if (!item) throw new AppError('Transação recorrente não encontrada', 404, 'NOT_FOUND')

    if (body.category !== undefined) {
      const { category, categoryName } = await resolveCategory(body.category, req.userId)
      body.category = category
      body.categoryName = categoryName
    }
    if (body.amount !== undefined) {
      body.amount = mongoose.Types.Decimal128.fromString(body.amount.toFixed(2))
    }
    if (body.startDate) body.startDate = new Date(body.startDate)
    if (body.endDate) body.endDate = new Date(body.endDate)

    Object.assign(item, body)
    await item.save()
    res.json({ success: true, data: item })
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(err.errors[0].message, 400, 'VALIDATION_ERROR'))
    next(err)
  }
}

exports.remove = async (req, res, next) => {
  try {
    const item = await RecurringTransaction.findOne({ _id: req.params.id, userId: req.userId })
    if (!item) throw new AppError('Transação recorrente não encontrada', 404, 'NOT_FOUND')
    await item.deleteOne()
    res.json({ success: true, message: 'Transação recorrente removida.' })
  } catch (err) { next(err) }
}

/**
 * Aplica as transações recorrentes para um mês específico.
 * Idempotente: verifica lastAppliedMonth para não duplicar.
 */
exports.applyToMonth = async (req, res, next) => {
  try {
    const { id } = req.params
    const { year, month } = req.body

    if (!year || !month) throw new AppError('year e month são obrigatórios', 400, 'VALIDATION_ERROR')

    const recurring = await RecurringTransaction.findOne({ _id: id, userId: req.userId })
    if (!recurring) throw new AppError('Transação recorrente não encontrada', 404, 'NOT_FOUND')

    const monthKey = `${year}-${month}`
    if (recurring.lastAppliedMonth === monthKey) {
      return res.json({ success: true, message: 'Já aplicado neste mês.', data: [] })
    }

    const targetDate = new Date(year, month - 1, 1)
    const startDate = new Date(recurring.startDate)
    const endDate = recurring.endDate ? new Date(recurring.endDate) : null

    if (startDate > new Date(year, month - 1, 31)) {
      return res.json({ success: true, message: 'Recorrência ainda não iniciou neste mês.', data: [] })
    }
    if (endDate && endDate < new Date(year, month - 1, 1)) {
      return res.json({ success: true, message: 'Recorrência já encerrou.', data: [] })
    }

    const created = []
    const daysInMonth = new Date(year, month, 0).getDate()

    if (recurring.frequency === 'monthly') {
      const day = Math.min(recurring.dayOfMonth, daysInMonth)
      const date = new Date(year, month - 1, day)
      const t = await Transaction.create({
        userId: req.userId,
        date,
        description: recurring.description,
        amount: recurring.amount,
        type: recurring.type,
        category: recurring.category,
        categoryName: recurring.categoryName,
        note: recurring.note,
        month: parseInt(month),
        year: parseInt(year),
        isRecurringGenerated: true,
        parentRecurringId: recurring._id,
      })
      created.push(t)
    } else if (recurring.frequency === 'weekly') {
      // Encontrar todos os dias do mês com o dayOfWeek correto
      for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(year, month - 1, d)
        if (date.getDay() === recurring.dayOfWeek) {
          const t = await Transaction.create({
            userId: req.userId,
            date,
            description: recurring.description,
            amount: recurring.amount,
            type: recurring.type,
            category: recurring.category,
            categoryName: recurring.categoryName,
            note: recurring.note,
            month: parseInt(month),
            year: parseInt(year),
            isRecurringGenerated: true,
            parentRecurringId: recurring._id,
          })
          created.push(t)
        }
      }
    } else if (recurring.frequency === 'daily') {
      for (let d = 1; d <= daysInMonth; d++) {
        const date = new Date(year, month - 1, d)
        const t = await Transaction.create({
          userId: req.userId,
          date,
          description: recurring.description,
          amount: recurring.amount,
          type: recurring.type,
          category: recurring.category,
          categoryName: recurring.categoryName,
          note: recurring.note,
          month: parseInt(month),
          year: parseInt(year),
          isRecurringGenerated: true,
          parentRecurringId: recurring._id,
        })
        created.push(t)
      }
    }

    recurring.lastAppliedMonth = monthKey
    recurring.lastAppliedDate = new Date()
    await recurring.save()

    summaryService.recalculate(req.userId, parseInt(year), parseInt(month)).catch(() => {})

    res.json({ success: true, data: created, message: `${created.length} transações criadas.` })
  } catch (err) { next(err) }
}