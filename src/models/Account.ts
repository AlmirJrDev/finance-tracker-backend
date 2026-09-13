import { Schema, model, type InferSchemaType, type Types } from 'mongoose'

export const ACCOUNT_TYPES = ['checking', 'savings', 'credit_card', 'cash', 'investment', 'other'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

const providerSchema = new Schema(
  {
    name: { type: String, enum: ['pluggy'], required: true },
    itemId: { type: String, required: true },
    accountId: { type: String, required: true },
    connectorName: { type: String },
    /** Lançamentos do banco a partir desta data (antes disso vale o histórico manual) */
    importFrom: { type: String },
    lastSyncAt: { type: Date },
  },
  { _id: false }
)

/** Onde o dinheiro está: conta corrente, poupança, cartão, carteira... */
const accountSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 50 },
    type: { type: String, enum: ACCOUNT_TYPES, default: 'checking' },
    color: { type: String, default: '#10B981', match: /^#[0-9A-Fa-f]{6}$/ },
    icon: { type: String, maxlength: 16 },
    /** Conta usada quando uma transação não informa a conta */
    isDefault: { type: Boolean, default: false },
    isArchived: { type: Boolean, default: false },
    provider: { type: providerSchema, default: undefined },
  },
  { timestamps: true }
)

accountSchema.index(
  { userId: 1, name: 1 },
  { unique: true, collation: { locale: 'pt', strength: 1 }, name: 'userId_account_name_ci' }
)
accountSchema.index(
  { userId: 1, 'provider.accountId': 1 },
  { unique: true, partialFilterExpression: { 'provider.accountId': { $exists: true } }, name: 'provider_account_unique' }
)

export type AccountDoc = InferSchemaType<typeof accountSchema> & { _id: Types.ObjectId }

export const Account = model('Account', accountSchema)
