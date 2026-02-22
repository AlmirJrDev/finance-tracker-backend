const mongoose = require('mongoose')

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    name: { type: String, required: true, trim: true },
    googleId: { type: String, unique: true, sparse: true },
    avatar: { type: String },
    preferences: {
      timezone: { type: String, default: 'America/Sao_Paulo' },
      currency: { type: String, default: 'BRL' },
      dateFormat: { type: String, default: 'DD/MM/YYYY' },
      autoBackup: { type: Boolean, default: true },
      backupInterval: { type: Number, default: 300000 },
    },
  },
  { timestamps: true }
)

module.exports = mongoose.model('User', userSchema)