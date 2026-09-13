import { Schema, model, type InferSchemaType, type Types } from 'mongoose'
import { MAX_AMOUNT_CENTS } from './Transaction'

/** Limite mensal de gastos de uma categoria. Vale para todos os meses. */
const budgetSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    amountCents: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_AMOUNT_CENTS,
      validate: { validator: Number.isInteger, message: 'amountCents deve ser inteiro' },
    },
    // Percentual a partir do qual o orçamento entra em alerta
    alertPercent: { type: Number, min: 1, max: 100, default: 80 },
  },
  { timestamps: true }
)

budgetSchema.index({ userId: 1, categoryId: 1 }, { unique: true })

export type BudgetDoc = InferSchemaType<typeof budgetSchema> & { _id: Types.ObjectId }

export const Budget = model('Budget', budgetSchema)
