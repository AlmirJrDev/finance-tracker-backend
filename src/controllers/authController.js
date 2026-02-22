const { OAuth2Client } = require('google-auth-library')
const User = require('../models/User')
const { generateToken } = require('../middleware/auth')
const { AppError } = require('../middleware/errorHandler')
const logger = require('../utils/logger')

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)

/**
 * POST /api/auth/google
 * Recebe o idToken do Google (do frontend via google-one-tap ou oauth popup)
 * Valida, cria/busca usuário, retorna JWT próprio.
 */
exports.googleLogin = async (req, res, next) => {
  try {
    const { idToken } = req.body
    if (!idToken) throw new AppError('idToken é obrigatório', 400, 'VALIDATION_ERROR')

    // Verificar token com Google
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    })
    const payload = ticket.getPayload()

    const { sub: googleId, email, name, picture } = payload

    // Upsert do usuário
    let user = await User.findOneAndUpdate(
      { googleId },
      { email, name, avatar: picture, googleId },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    )

    const token = generateToken(user._id.toString())

    res.json({
      success: true,
      data: {
        token,
        user: { id: user._id, email: user.email, name: user.name, avatar: user.avatar },
      },
    })
  } catch (err) {
    logger.error('Google login error:', err)
    next(err)
  }
}

/**
 * GET /api/auth/me
 * Retorna dados do usuário autenticado
 */
exports.me = async (req, res) => {
  res.json({
    success: true,
    data: {
      id: req.user._id,
      email: req.user.email,
      name: req.user.name,
      avatar: req.user.avatar,
      preferences: req.user.preferences,
    },
  })
}

/**
 * PUT /api/auth/preferences
 * Atualiza preferências do usuário
 */
exports.updatePreferences = async (req, res, next) => {
  try {
    const allowed = ['timezone', 'currency', 'dateFormat', 'autoBackup', 'backupInterval']
    const updates = {}
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[`preferences.${key}`] = req.body[key]
    }

    const user = await User.findByIdAndUpdate(req.userId, { $set: updates }, { new: true }).lean()
    res.json({ success: true, data: { preferences: user.preferences } })
  } catch (err) { next(err) }
}