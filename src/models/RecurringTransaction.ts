import { Schema, model, type InferSchemaType, type Types } from 'mongoose'
import { DATE_RE } from '../lib/dates'
import { MAX_AMOUNT_CENTS, TRANSACTION_TYPES } from './Transaction'

export const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const
export type Frequency = (typeof FREQUENCIES)[number]

const recurringSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
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
    frequency: { type: String, required: true, enum: FREQUENCIES },
    dayOfMonth: { type: Number, min: 1, max: 31, default: null }, // monthly
    dayOfWeek: { type: Number, min: 0, max: 6, default: null }, // weekly (0 = domingo)
    isActive: { type: Boolean, default: true },
    startDate: { type: String, required: true, match: DATE_RE },
    endDate: { type: String, match: DATE_RE, default: null },
    note: { type: String, maxlength: 500, trim: true },
  },
  { timestamps: true }
)

recurringSchema.index({ userId: 1, isActive: 1 })

export type RecurringDoc = InferSchemaType<typeof recurringSchema> & { _id: Types.ObjectId }

export const RecurringTransaction = model('RecurringTransaction', recurringSchema)
