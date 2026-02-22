const logger = require('../utils/logger')
const { v4: uuidv4 } = require('uuid')

function errorHandler(err, req, res, next) {
  const requestId = uuidv4()
  logger.error(`[${requestId}] ${err.message}`, {
    stack: err.stack,
    url: req.originalUrl,
    method: req.method,
    userId: req.userId,
  })

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message)
    return res.status(400).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: messages[0],
      details: messages,
    })
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0]
    return res.status(409).json({
      success: false,
      error: 'DUPLICATE_KEY',
      message: `Já existe um registro com esse ${field}.`,
    })
  }

  // Erros explícitos lançados pelos controllers
  if (err.statusCode) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.code || 'ERROR',
      message: err.message,
    })
  }

  return res.status(500).json({
    success: false,
    error: 'INTERNAL_ERROR',
    message: 'Erro ao processar a requisição.',
    requestId,
  })
}

/**
 * Classe de erro customizado para lançar nos controllers
 */
class AppError extends Error {
  constructor(message, statusCode, code) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

module.exports = { errorHandler, AppError }