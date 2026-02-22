const jwt = require('jsonwebtoken')
const User = require('../models/User')
const logger = require('../utils/logger')

/**
 * Middleware principal de autenticação via JWT.
 * O token deve vir no header Authorization: Bearer <token>
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Token de autenticação não fornecido.',
      })
    }

    const token = authHeader.split(' ')[1]
    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    const user = await User.findById(decoded.userId).lean()
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Usuário não encontrado.',
      })
    }

    req.user = user
    req.userId = user._id.toString()
    next()
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'TOKEN_EXPIRED',
        message: 'Sessão expirada. Faça login novamente.',
      })
    }
    logger.error('Auth error:', err)
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Token inválido.',
    })
  }
}

/**
 * Gera um JWT para o usuário
 */
function generateToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  })
}

module.exports = { authenticate, generateToken }