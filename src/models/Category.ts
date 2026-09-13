import { Schema, model, type InferSchemaType, type Types } from 'mongoose'

const categorySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 50 },
    color: { type: String, default: '#6B7280', match: /^#[0-9A-Fa-f]{6}$/ },
    // Emojis compostos (ex.: 🍽️) ocupam mais de 2 code units
    icon: { type: String, maxlength: 16 },
    description: { type: String, maxlength: 200 },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
)

// Nome único por usuário, sem diferenciar maiúsculas/acentos ("lazer" == "Lazer")
categorySchema.index(
  { userId: 1, name: 1 },
  { unique: true, collation: { locale: 'pt', strength: 1 }, name: 'userId_name_ci' }
)

export type CategoryDoc = InferSchemaType<typeof categorySchema> & { _id: Types.ObjectId }

export const Category = model('Category', categorySchema)
