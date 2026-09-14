import { Schema, model, type InferSchemaType, type Types } from 'mongoose'
import { DATE_RE } from '../lib/dates'

/** Conexão com uma instituição via Pluggy (um "item" na API deles). */
const bankConnectionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: String, enum: ['pluggy'], default: 'pluggy' },
    itemId: { type: String, required: true },
    connectorId: { type: Number },
    connectorName: { type: String },
    status: { type: String },
    /** Transações do banco a partir desta data; antes dela o saldo entra como ajuste */
    importFrom: { type: String, required: true, match: DATE_RE },
    lastSyncAt: { type: Date },
    lastSyncError: { type: String, default: null },
  },
  { timestamps: true }
)

bankConnectionSchema.index({ provider: 1, itemId: 1 }, { unique: true })
bankConnectionSchema.index({ userId: 1 })

export type BankConnectionDoc = InferSchemaType<typeof bankConnectionSchema> & { _id: Types.ObjectId }

export const BankConnection = model('BankConnection', bankConnectionSchema)
