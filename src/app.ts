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
import { errorHandler } from './middleware/errorHandler'
import authRoutes from './routes/auth'
import transactionRoutes from './routes/transactions'
import categoryRoutes from './routes/categories'
import recurringRoutes from './routes/recurring'
import summaryRoutes from './routes/summary'
import budgetRoutes from './routes/budgets'
import cronRoutes from './routes/cron'

export function createApp() {
  const config = env()
  const app = express()
  const isTest = config.NODE_ENV === 'test'

  app.disable('x-powered-by')
  app.use(helmet())
  app.use(
    cors({
      origin: config.FRONTEND_URL.split(',').map((o) => o.trim()),
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
  app.use('/api/transactions', authenticate, transactionRoutes)
  app.use('/api/categories', authenticate, categoryRoutes)
  app.use('/api/recurring-transactions', authenticate, recurringRoutes)
  app.use('/api/summary', authenticate, summaryRoutes)
  app.use('/api/budgets', authenticate, budgetRoutes)
  app.use('/api/cron', cronRoutes)

  app.use((_req, res) => {
    res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Endpoint não encontrado.' })
  })
  app.use(errorHandler)

  return app
}
