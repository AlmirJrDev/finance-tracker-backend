const MonthlySummary = require('../models/MonthlySummary')
const { AppError } = require('../middleware/errorHandler')
const summaryService = require('../utils/summaryService')

exports.getMonthSummary = async (req, res, next) => {
  try {
    const { year, month } = req.params
    const y = parseInt(year)
    const m = parseInt(month)

    if (m < 1 || m > 12) throw new AppError('Mês inválido', 400, 'VALIDATION_ERROR')

    let summary = await MonthlySummary.findOne({ userId: req.userId, year: y, month: m }).lean()

    // Se não existe, calcular on-demand
    if (!summary) {
      await summaryService.recalculate(req.userId, y, m)
      summary = await MonthlySummary.findOne({ userId: req.userId, year: y, month: m }).lean()
    }

    const dailyBalances = await summaryService.getDailyBalances(req.userId, y, m)

    res.json({
      success: true,
      data: { ...summary, dailyBalances },
    })
  } catch (err) {
    next(err)
  }
}

exports.getAllMonths = async (req, res, next) => {
  try {
    const summaries = await MonthlySummary.find({ userId: req.userId }).sort({ year: -1, month: -1 }).lean()
    res.json({ success: true, data: summaries })
  } catch (err) {
    next(err)
  }
}

exports.getDailyBalance = async (req, res, next) => {
  try {
    const { year, month } = req.params
    const dailyBalances = await summaryService.getDailyBalances(req.userId, parseInt(year), parseInt(month))
    res.json({ success: true, data: dailyBalances })
  } catch (err) {
    next(err)
  }
}