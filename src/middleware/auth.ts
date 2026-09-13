import type { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import { env } from '../config/env'
import { User, type UserDoc } from '../models/User'
import { AppError } from '../lib/errors'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string
      user?: UserDoc
    }
  }
}

export function generateToken(userId: string): { token: string; expiresAt: string } {
  const token = jwt.sign({ userId }, env().JWT_SECRET, {
    expiresIn: env().JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  })
  const { exp } = jwt.decode(token) as { exp: number }
  return { token, expiresAt: new Date(exp * 1000).toISOString() }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      throw new AppError(401, 'UNAUTHORIZED', 'Token de autenticação não fornecido.')
    }

    let payload: { userId?: string }
    try {
      payload = jwt.verify(header.slice(7), env().JWT_SECRET) as { userId?: string }
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new AppError(401, 'TOKEN_EXPIRED', 'Sessão expirada. Faça login novamente.')
      }
      throw new AppError(401, 'UNAUTHORIZED', 'Token inválido.')
    }

    const user = payload.userId ? await User.findById(payload.userId).lean<UserDoc>() : null
    if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Usuário não encontrado.')

    req.user = user
    req.userId = user._id.toString()
    next()
  } catch (err) {
    next(err)
  }
}
