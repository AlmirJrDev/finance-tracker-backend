require('dotenv').config()

const express = require('express')
const helmet = require('helmet')
const cors = require('cors')
const compression = require('compression')
const morgan = require('morgan')
const rateLimit = require('express-rate-limit')

const connectDB = require('./config/database')
const routes = require('./routes')
const { errorHandler } = require('./middleware/errorHandler')
const logger = require('./utils/logger')

const app = express()

// ─── Segurança ────────────────────────────────────────────────────────────────
app.use(helmet())
app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  })
)

// Rate limiting geral
app.use(
  '/api/',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { success: false, error: 'RATE_LIMIT', message: 'Muitas requisições. Tente novamente em 15 minutos.' },
  })
)

// Rate limiting estrito para mutations
app.use(
  ['/api/transactions', '/api/recurring-transactions'],
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { success: false, error: 'RATE_LIMIT', message: 'Muitas requisições.' },
  })
)

// ─── Body parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10kb' }))
app.use(express.urlencoded({ extended: false, limit: '10kb' }))
app.use(compression())

// ─── Logging ──────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }))
}

// ─── Conectar ao banco antes de cada request (serverless safe) ────────────────
app.use(async (req, res, next) => {
  try {
    await connectDB()
    next()
  } catch (err) {
    res.status(503).json({ success: false, error: 'DB_ERROR', message: 'Erro ao conectar ao banco de dados.' })
  }
})

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }))

// ─── Rotas ────────────────────────────────────────────────────────────────────
app.use('/api', routes)

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'NOT_FOUND', message: 'Endpoint não encontrado.' })
})

// ─── Error handler ────────────────────────────────────────────────────────────
app.use(errorHandler)

// ─── Start local (desenvolvimento) ───────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3001
  connectDB().then(() => {
    app.listen(PORT, () => {
      logger.info(`Servidor rodando na porta ${PORT} [development]`)
    })
  }).catch((err) => {
    logger.error('Falha ao iniciar:', err)
    process.exit(1)
  })
}

module.exports = app