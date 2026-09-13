import type { NextFunction, Request, Response } from 'express'
import { User } from '../models/User'
import { logger } from '../lib/logger'

/** Não grava mais de uma vez nesse intervalo por usuário */
const THROTTLE_MS = 10 * 60 * 1000

/**
 * Registra a última atividade do usuário em requisições que alteram dados.
 * Roda antes do handler (e não no fim da resposta) porque na Vercel a função
 * pode ser congelada logo depois de responder.
 */
export async function trackActivity(req: Request, _res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || !req.userId) return next()

  const now = new Date()
  const last = req.user?.lastActivityAt ? new Date(req.user.lastActivityAt).getTime() : 0
  if (now.getTime() - last >= THROTTLE_MS) {
    try {
      await User.updateOne({ _id: req.userId }, { $set: { lastActivityAt: now } }, { timestamps: false })
    } catch (err) {
      // Nunca bloqueia a operação do usuário por causa disso
      logger.warn('Falha ao registrar atividade', { userId: req.userId, error: String(err) })
    }
  }
  next()
}
