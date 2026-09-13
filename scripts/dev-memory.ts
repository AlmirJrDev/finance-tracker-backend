/**
 * Sobe a API com um MongoDB local embutido (não precisa do Atlas).
 * Os dados ficam em .data/mongo e sobrevivem entre execuções.
 *
 *   npm run dev:memory
 */
import 'dotenv/config'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { MongoMemoryServer } from 'mongodb-memory-server'

async function main() {
  const dbPath = path.resolve(__dirname, '../.data/mongo')
  mkdirSync(dbPath, { recursive: true })

  const mongo = await MongoMemoryServer.create({
    instance: { dbPath, storageEngine: 'wiredTiger', port: 27018 },
  })

  process.env.MONGODB_URI = mongo.getUri('finance-tracker')
  process.env.NODE_ENV ??= 'development'
  process.env.JWT_SECRET ??= 'dev-secret-somente-local-123456'
  process.env.ALLOW_DEV_LOGIN ??= 'true'

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
