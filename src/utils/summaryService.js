const mongoose = require('mongoose')
const Transaction = require('../models/Transaction')
const MonthlySummary = require('../models/MonthlySummary')
const logger = require('./logger')

/**
 * Recalcula e persiste o MonthlySummary para um determinado mês/ano/usuário.
 * Também busca o saldo final do mês anterior para usar como initialBalance.
 */
async function recalculate(userId, year, month) {
  try {
    const userObjectId = new mongoose.Types.ObjectId(userId)

    // Buscar todas as transações do mês
    const transactions = await Transaction.find({ userId: userObjectId, year, month }).lean()

    let totalIncome = 0
    let totalExpense = 0
    const categoryBreakdown = {}

    for (const t of transactions) {
      const amount = parseFloat(t.amount.toString())
      if (t.type === 'entrada') {
        totalIncome += amount
      } else {
        totalExpense += amount
      }
      if (t.categoryName) {
        categoryBreakdown[t.categoryName] = (categoryBreakdown[t.categoryName] || 0) + amount * (t.type === 'entrada' ? 1 : -1)
      }
    }

    // Buscar initialBalance do mês anterior
    const prevYear = month === 1 ? year - 1 : year
    const prevMonth = month === 1 ? 12 : month - 1
    const prevSummary = await MonthlySummary.findOne({ userId: userObjectId, year: prevYear, month: prevMonth }).lean()

    const initialBalance = prevSummary ? parseFloat(prevSummary.finalBalance.toString()) : 0
    const performance = totalIncome - totalExpense
    const finalBalance = initialBalance + performance

    const toDecimal = (n) => mongoose.Types.Decimal128.fromString(n.toFixed(2))
    const breakdownDecimal = {}
    for (const [k, v] of Object.entries(categoryBreakdown)) {
      breakdownDecimal[k] = toDecimal(v)
    }

    await MonthlySummary.findOneAndUpdate(
      { userId: userObjectId, year, month },
      {
        initialBalance: toDecimal(initialBalance),
        totalIncome: toDecimal(totalIncome),
        totalExpense: toDecimal(totalExpense),
        performance: toDecimal(performance),
        finalBalance: toDecimal(finalBalance),
        transactionCount: transactions.length,
        categoryBreakdown: breakdownDecimal,
        lastUpdated: new Date(),
      },
      { upsert: true, new: true }
    )

    // Propagar carryover para meses seguintes (até 3 meses à frente, ou enquanto existirem summaries)
    await propagateCarryover(userObjectId, year, month, finalBalance)

    logger.debug(`Summary recalculado: ${year}-${month} para userId ${userId}`)
  } catch (err) {
    logger.error('Erro ao recalcular summary:', err)
    throw err
  }
}

/**
 * Propaga o saldo final como initialBalance dos meses seguintes em cascata.
 */
async function propagateCarryover(userId, year, month, finalBalance) {
  let currentBalance = finalBalance
  let y = year
  let m = month

  for (let i = 0; i < 24; i++) {
    m += 1
    if (m > 12) { m = 1; y += 1 }

    const next = await MonthlySummary.findOne({ userId, year: y, month: m }).lean()
    if (!next) break

    const income = parseFloat(next.totalIncome.toString())
    const expense = parseFloat(next.totalExpense.toString())
    const newFinal = currentBalance + income - expense

    const toD = (n) => mongoose.Types.Decimal128.fromString(n.toFixed(2))
    await MonthlySummary.updateOne(
      { userId, year: y, month: m },
      { initialBalance: toD(currentBalance), performance: toD(income - expense), finalBalance: toD(newFinal), lastUpdated: new Date() }
    )

    currentBalance = newFinal
  }
}

/**
 * Calcula saldos diários para um mês.
 */
async function getDailyBalances(userId, year, month) {
  const userObjectId = new mongoose.Types.ObjectId(userId)
  const summary = await MonthlySummary.findOne({ userId: userObjectId, year, month }).lean()
  const initialBalance = summary ? parseFloat(summary.initialBalance.toString()) : 0

  const transactions = await Transaction.find({ userId: userObjectId, year, month }).sort({ date: 1 }).lean()

  // Agrupar por dia
  const daysInMonth = new Date(year, month, 0).getDate()
  const dailyMap = {}

  for (const t of transactions) {
    const day = new Date(t.date).getDate()
    if (!dailyMap[day]) dailyMap[day] = { income: 0, expense: 0, count: 0 }
    const amount = parseFloat(t.amount.toString())
    if (t.type === 'entrada') dailyMap[day].income += amount
    else dailyMap[day].expense += amount
    dailyMap[day].count++
  }

  let runningBalance = initialBalance
  const dailyBalances = []

  for (let d = 1; d <= daysInMonth; d++) {
    const day = dailyMap[d] || { income: 0, expense: 0, count: 0 }
    runningBalance += day.income - day.expense
    dailyBalances.push({
      date: new Date(year, month - 1, d).toISOString(),
      income: day.income,
      expense: day.expense,
      balance: runningBalance,
      transactionCount: day.count,
    })
  }

  return dailyBalances
}

module.exports = { recalculate, getDailyBalances }