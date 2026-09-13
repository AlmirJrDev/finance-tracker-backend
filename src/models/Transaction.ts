import { Schema, model, type InferSchemaType, type Types } from 'mongoose'
import { DATE_RE } from '../lib/dates'

export const MAX_AMOUNT_CENTS = 99_999_999 // R$ 999.999,99
export const TRANSACTION_TYPES = ['income', 'expense'] as const
export type TransactionType = (typeof TRANSACTION_TYPES)[number]

// Documentos antigos não têm status: são tratados como pagos
export const TRANSACTION_STATUSES = ['paid', 'pending'] as const
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number]

const installmentSchema = new Schema(
  {
    groupId: { type: Schema.Types.ObjectId, required: true },
    number: { type: Number, required: true, min: 1 },
    total: { type: Number, required: true, min: 2 },
  },
  { _id: false }
)

const transactionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    date: { type: String, required: true, match: DATE_RE }, // YYYY-MM-DD
    description: { type: String, required: true, trim: true, minlength: 2, maxlength: 200 },
    amountCents: {
      type: Number,
      required: true,
      min: 1,
      max: MAX_AMOUNT_CENTS,
      validate: { validator: Number.isInteger, message: 'amountCents deve ser inteiro' },
    },
    type: { type: String, required: true, enum: TRANSACTION_TYPES },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', default: null },
    note: { type: String, maxlength: 500, trim: true },
    recurringId: { type: Schema.Types.ObjectId, ref: 'RecurringTransaction', default: null },
    status: { type: String, enum: TRANSACTION_STATUSES, default: 'paid' },
    installment: { type: installmentSchema, default: undefined },
  },
  { timestamps: true }
)

transactionSchema.index({ userId: 1, date: -1 })
transactionSchema.index({ userId: 1, status: 1, date: 1 })
transactionSchema.index(
  { userId: 1, 'installment.groupId': 1 },
  { partialFilterExpression: { 'installment.groupId': { $exists: true } }, name: 'installment_group' }
)
transactionSchema.index({ userId: 1, categoryId: 1 })
// Garante que cada ocorrência de uma recorrência exista uma única vez
transactionSchema.index(
  { userId: 1, recurringId: 1, date: 1 },
  {
    unique: true,
    partialFilterExpression: { recurringId: { $type: 'objectId' } },
    name: 'recurring_occurrence_unique',
  }
)

export type TransactionDoc = InferSchemaType<typeof transactionSchema> & { _id: Types.ObjectId }

export const Transaction = model('Transaction', transactionSchema)
