const mongoose = require('mongoose')

const categorySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 50 },
    color: {
      type: String,
      default: '#6B7280',
      match: /^#[0-9A-Fa-f]{6}$/,
    },
    icon: { type: String, maxlength: 10 },
    description: { type: String, maxlength: 200 },
    isDefault: { type: Boolean, default: false },
    transactionCount: { type: Number, default: 0 },
  },
  { timestamps: true }
)

categorySchema.index({ userId: 1, name: 1 }, { unique: true })
categorySchema.index({ userId: 1, isDefault: 1 })

module.exports = mongoose.model('Category', categorySchema)