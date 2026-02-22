const mongoose = require('mongoose')

const monthlySummarySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },
    initialBalance: { type: mongoose.Decimal128, default: 0 },
    totalIncome: { type: mongoose.Decimal128, default: 0 },
    totalExpense: { type: mongoose.Decimal128, default: 0 },
    performance: { type: mongoose.Decimal128, default: 0 },
    finalBalance: { type: mongoose.Decimal128, default: 0 },
    transactionCount: { type: Number, default: 0 },
    recurringTransactionCount: { type: Number, default: 0 },
    categoryBreakdown: { type: Map, of: mongoose.Decimal128, default: {} },
    lastUpdated: { type: Date, default: Date.now },
  },
  {
    toJSON: {
      transform: (doc, ret) => {
        const decFields = ['initialBalance', 'totalIncome', 'totalExpense', 'performance', 'finalBalance']
        decFields.forEach((f) => {
          if (ret[f]) ret[f] = parseFloat(ret[f].toString())
        })
        return ret
      },
    },
  }
)

monthlySummarySchema.index({ userId: 1, year: 1, month: 1 }, { unique: true })

module.exports = mongoose.model('MonthlySummary', monthlySummarySchema)