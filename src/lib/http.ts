import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { z } from 'zod'
import { AppError, badRequest } from './errors'

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>

/** Express 4 não captura erros de funções async; isso repassa para o errorHandler. */
export const asyncHandler =
  (fn: AsyncHandler): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next)
  }

const OBJECT_ID_RE = /^[a-f\d]{24}$/i

export const objectIdSchema = z.string().regex(OBJECT_ID_RE, 'ID inválido')

export function parseId(value: string): string {
  if (!OBJECT_ID_RE.test(value)) throw badRequest('ID inválido')
  return value
}

export function currentUserId(req: Request): string {
  if (!req.userId) throw new AppError(401, 'UNAUTHORIZED', 'Não autenticado.')
  return req.userId
}
