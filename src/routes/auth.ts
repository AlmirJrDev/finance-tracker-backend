import { Router } from 'express'
import { OAuth2Client } from 'google-auth-library'
import { z } from 'zod'
import { devLoginEnabled, env } from '../config/env'
import { User, type UserDoc } from '../models/User'
import { authenticate, generateToken } from '../middleware/auth'
import { ensureDefaultCategories } from '../services/categories'
import { ensureDefaultAccount } from '../services/accounts'
import { AppError } from '../lib/errors'
import { asyncHandler, currentUserId } from '../lib/http'
import { logger } from '../lib/logger'

const router = Router()

export type GoogleProfile = { googleId: string; email: string; name: string; avatar?: string }

let googleClient: OAuth2Client | null = null

/** Isolado em um objeto para os testes poderem substituir a verificação. */
export const googleVerifier = {
  async verify(idToken: string): Promise<GoogleProfile> {
    const clientId = env().GOOGLE_CLIENT_ID
    if (!clientId) throw new AppError(500, 'CONFIG_ERROR', 'GOOGLE_CLIENT_ID não configurado.')
    googleClient ??= new OAuth2Client(clientId)

    try {
      const ticket = await googleClient.verifyIdToken({ idToken, audience: clientId })
      const p = ticket.getPayload()
      if (!p?.sub || !p.email) throw new Error('payload sem sub/email')
      return { googleId: p.sub, email: p.email, name: p.name ?? p.email, avatar: p.picture }
    } catch (err) {
      logger.warn('Token do Google rejeitado', { error: String(err) })
      throw new AppError(401, 'INVALID_GOOGLE_TOKEN', 'Login do Google inválido ou expirado. Entre novamente.')
    }
  },
}

function toUserDTO(u: UserDoc) {
  return {
    id: u._id.toString(),
    email: u.email,
    name: u.name,
    avatar: u.avatar ?? null,
    preferences: {
      timezone: u.preferences?.timezone ?? 'America/Sao_Paulo',
      currency: u.preferences?.currency ?? 'BRL',
    },
  }
}

async function respondWithSession(res: import('express').Response, user: UserDoc) {
  await Promise.all([ensureDefaultCategories(user._id), ensureDefaultAccount(user._id)])
  const { token, expiresAt } = generateToken(user._id.toString())
  res.json({ success: true, data: { token, expiresAt, user: toUserDTO(user) } })
}

router.post(
  '/google',
  asyncHandler(async (req, res) => {
    const { idToken } = z.object({ idToken: z.string().min(1) }).parse(req.body)
    const profile = await googleVerifier.verify(idToken)

    // Busca por googleId ou, se a conta existir só com e-mail, vincula.
    const user = await User.findOneAndUpdate(
      { $or: [{ googleId: profile.googleId }, { email: profile.email.toLowerCase() }] },
      { $set: { googleId: profile.googleId, email: profile.email, name: profile.name, avatar: profile.avatar } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean<UserDoc>()

    await respondWithSession(res, user!)
  })
)

router.post(
  '/dev',
  asyncHandler(async (req, res) => {
    if (!devLoginEnabled()) throw new AppError(404, 'NOT_FOUND', 'Endpoint não encontrado.')
    const body = z
      .object({ email: z.string().email().default('dev@local.test'), name: z.string().min(1).default('Dev Local') })
      .parse(req.body ?? {})

    const user = await User.findOneAndUpdate(
      { email: body.email.toLowerCase() },
      { $setOnInsert: { email: body.email, name: body.name } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean<UserDoc>()

    await respondWithSession(res, user!)
  })
)

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: toUserDTO(req.user!) })
  })
)

router.put(
  '/preferences',
  authenticate,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        timezone: z
          .string()
          .refine((tz) => Intl.supportedValuesOf('timeZone').includes(tz), 'Fuso horário inválido')
          .optional(),
        currency: z.string().length(3).toUpperCase().optional(),
      })
      .parse(req.body)

    const updates = Object.fromEntries(Object.entries(body).map(([k, v]) => [`preferences.${k}`, v]))
    const user = await User.findByIdAndUpdate(currentUserId(req), { $set: updates }, { new: true }).lean<UserDoc>()
    res.json({ success: true, data: toUserDTO(user!) })
  })
)

export default router
