import express from 'express'
import helmet from 'helmet'
import cors from 'cors'
import compression from 'compression'
import morgan from 'morgan'
import rateLimit from 'express-rate-limit'

import { env } from './config/env'
import { connectDB } from './lib/db'
import { asyncHandler } from './lib/http'
import { AppError } from './lib/errors'
import { authenticate } from './middleware/auth'
import { trackActivity } from './middleware/activity'
import { errorHandler } from './middleware/errorHandler'
import authRoutes from './routes/auth'
import transactionRoutes from './routes/transactions'
import categoryRoutes from './routes/categories'
import recurringRoutes from './routes/recurring'
import summaryRoutes from './routes/summary'
import budgetRoutes from './routes/budgets'
import accountRoutes from './routes/accounts'
import cronRoutes from './routes/cron'

const normalizeOrigin = (o: string) => o.trim().replace(/\/+$/, '').toLowerCase()

/**
 * FRONTEND_URL aceita "*" (qualquer origem) ou uma lista separada por vírgula.
 * Barras finais e maiúsculas são ignoradas ("https://app.com/" == "https://app.com").
 */
export function corsOrigin(value: string): boolean | ((origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void) {
  const allowed = value.split(',').map(normalizeOrigin).filter(Boolean)
  if (allowed.includes('*')) return true
  return (origin, cb) => cb(null, !origin || allowed.includes(normalizeOrigin(origin)))
}

export function createApp() {
  const config = env()
  const app = express()
  const isTest = config.NODE_ENV === 'test'

  app.disable('x-powered-by')
  app.use(helmet())
  app.use(
    cors({
      origin: corsOrigin(config.FRONTEND_URL),
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    })
  )

  if (!isTest) {
    app.use(
      '/api/',
      rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 600,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { success: false, error: 'RATE_LIMIT', message: 'Muitas requisições. Tente novamente em alguns minutos.' },
      })
    )
  }

  app.use(express.json({ limit: '100kb' }))
  app.use(compression())
  if (config.NODE_ENV === 'development') app.use(morgan('dev'))

  // Conecta sob demanda (seguro para serverless)
  app.use(
    asyncHandler(async (_req, _res, next) => {
      try {
        await connectDB()
      } catch {
        throw new AppError(503, 'DB_ERROR', 'Erro ao conectar ao banco de dados.')
      }
      next()
    })
  )

  app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }))

  app.use('/api/auth', authRoutes)
  app.use('/api/transactions', authenticate, trackActivity, transactionRoutes)
  app.use('/api/categories', authenticate, trackActivity, categoryRoutes)
  app.use('/api/recurring-transactions', authenticate, trackActivity, recurringRoutes)
  app.use('/api/summary', authenticate, summaryRoutes)
  app.use('/api/budgets', authenticate, trackActivity, budgetRoutes)
  app.use('/api/accounts', authenticate, trackActivity, accountRoutes)
  app.use('/api/cron', cronRoutes)

  app.use((_req, res) => {
    res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Endpoint não encontrado.' })
  })
  app.use(errorHandler)

  return app
}
