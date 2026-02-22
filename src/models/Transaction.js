const mongoose = require('mongoose')

const transactionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: Date, required: true },
    description: { type: String, required: true, trim: true, minlength: 3, maxlength: 200 },
    amount: { type: mongoose.Decimal128, required: true },
    type: { type: String, required: true, enum: ['entrada', 'saída'] },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
    categoryName: { type: String }, // desnormalizado para performance
    note: { type: String, maxlength: 500, trim: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },
    isRecurringGenerated: { type: Boolean, default: false },
    parentRecurringId: { type: mongoose.Schema.Types.ObjectId, ref: 'RecurringTransaction', default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        if (ret.amount) ret.amount = parseFloat(ret.amount.toString())
        return ret
      },
    },
  }
)

transactionSchema.index({ userId: 1, date: -1 })
transactionSchema.index({ userId: 1, month: 1, year: 1 })
transactionSchema.index({ userId: 1, category: 1 })

module.exports = mongoose.model('Transaction', transactionSchema)