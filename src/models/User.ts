import { Schema, model, type InferSchemaType, type Types } from 'mongoose'

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    googleId: { type: String, unique: true, sparse: true },
    avatar: { type: String },
    /** Última vez que o usuário alterou algum dado (só visualizar não conta) */
    lastActivityAt: { type: Date },
    preferences: {
      timezone: { type: String, default: 'America/Sao_Paulo' },
      currency: { type: String, default: 'BRL' },
    },
  },
  { timestamps: true }
)

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId }

export const User = model('User', userSchema)
