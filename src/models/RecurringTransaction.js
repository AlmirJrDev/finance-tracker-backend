const mongoose = require('mongoose')

const recurringTransactionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    description: { type: String, required: true, trim: true, minlength: 3, maxlength: 200 },
    amount: { type: mongoose.Decimal128, required: true },
    type: { type: String, required: true, enum: ['entrada', 'saída'] },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', default: null },
    categoryName: { type: String },
    frequency: { type: String, required: true, enum: ['daily', 'weekly', 'monthly'] },
    dayOfMonth: { type: Number, min: 1, max: 31, default: null }, // para monthly
    dayOfWeek: { type: Number, min: 0, max: 6, default: null },   // para weekly (0=domingo)
    isActive: { type: Boolean, default: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    note: { type: String, maxlength: 500 },
    lastAppliedMonth: { type: String, default: null }, // formato "YYYY-M"
    lastAppliedDate: { type: Date, default: null },
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

recurringTransactionSchema.index({ userId: 1, isActive: 1 })
recurringTransactionSchema.index({ userId: 1, startDate: 1, endDate: 1 })

module.exports = mongoose.model('RecurringTransaction', recurringTransactionSchema)