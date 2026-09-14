/**
 * Sobe a API com um MongoDB local embutido (não precisa do Atlas).
 * Os dados ficam em .data/mongo e sobrevivem entre execuções.
 *
 *   npm run dev:memory
 *
 * Não carrega o .env de propósito: ele pode ter credenciais de produção
 * (banco, JWT_SECRET, CRON_SECRET) que nunca devem ser usadas localmente.
 * Só as credenciais da Pluggy são aproveitadas, para testar a conexão bancária.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'dotenv'
import { MongoMemoryServer } from 'mongodb-memory-server'

function pluggyFromDotenv(): Record<string, string> {
  const file = path.resolve(__dirname, '../.env')
  if (!existsSync(file)) return {}
  const values = parse(readFileSync(file))
  return Object.fromEntries(Object.entries(values).filter(([k]) => ['PLUGGY_CLIENT_ID', 'PLUGGY_CLIENT_SECRET'].includes(k)))
}

async function main() {
  const dbPath = path.resolve(__dirname, '../.data/mongo')
  mkdirSync(dbPath, { recursive: true })

  const mongo = await MongoMemoryServer.create({
    instance: { dbPath, storageEngine: 'wiredTiger', port: 27018 },
  })

  Object.assign(process.env, {
    MONGODB_URI: mongo.getUri('finance-tracker'),
    NODE_ENV: 'development',
    PORT: process.env.DEV_API_PORT ?? '3001',
    JWT_SECRET: 'dev-secret-somente-local-123456',
    FRONTEND_URL: 'http://localhost:3000',
    ALLOW_DEV_LOGIN: 'true',
    GOOGLE_CLIENT_ID: '',
    CRON_SECRET: 'cron-secret-somente-local',
    ...pluggyFromDotenv(),
    PLUGGY_ALLOWED_EMAILS: process.env.DEV_PLUGGY_EMAIL ?? 'almir@local.test',
  })

  const { createApp } = await import('../src/app')
  const { connectDB } = await import('../src/lib/db')
  const { env } = await import('../src/config/env')

  await connectDB()
  const { PORT } = env()
  createApp().listen(PORT, () => {
    console.log(`API em http://localhost:${PORT} usando MongoDB local (${process.env.MONGODB_URI})`)
    console.log(`Login de desenvolvimento: POST http://localhost:${PORT}/api/auth/dev`)
  })

  const stop = async () => {
    await mongo.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
