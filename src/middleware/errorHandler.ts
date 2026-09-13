import { randomUUID } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'
import mongoose from 'mongoose'
import { ZodError } from 'zod'
import { AppError, isDuplicateKeyError } from '../lib/errors'
import { logger } from '../lib/logger'

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    const first = details[0]
    return res.status(400).json({
      success: false,
      error: 'VALIDATION_ERROR',
      message: first.path ? `${first.path}: ${first.message}` : first.message,
      details,
    })
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    })
  }

  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((e) => ({ path: e.path, message: e.message }))
    return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: details[0].message, details })
  }

  if (err instanceof mongoose.Error.CastError) {
    return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', message: `Valor inválido para ${err.path}` })
  }

  if (isDuplicateKeyError(err)) {
    return res.status(409).json({ success: false, error: 'DUPLICATE_KEY', message: 'Já existe um registro com esses dados.' })
  }

  // JSON malformado no body
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ success: false, error: 'INVALID_JSON', message: 'JSON inválido.' })
  }

  const requestId = randomUUID()
  logger.error('Erro não tratado', {
    requestId,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    method: req.method,
    url: req.originalUrl,
    userId: req.userId,
  })

  return res.status(500).json({
    success: false,
    error: 'INTERNAL_ERROR',
    message: 'Erro ao processar a requisição.',
    requestId,
  })
}
