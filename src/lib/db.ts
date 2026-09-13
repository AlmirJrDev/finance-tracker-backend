import mongoose from 'mongoose'
import { env } from '../config/env'
import { logger } from './logger'

mongoose.set('strictQuery', true)

// Reaproveita a conexão entre invocações serverless e evita conexões paralelas.
let connecting: Promise<typeof mongoose> | null = null

export async function connectDB(uri = env().MONGODB_URI): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose

  if (!connecting) {
    connecting = mongoose
      .connect(uri, {
        serverSelectionTimeoutMS: 5000,
        maxPoolSize: 10,
        minPoolSize: 0,
        maxIdleTimeMS: 10000,
        socketTimeoutMS: 20000,
      })
      .then((conn) => {
        logger.info('MongoDB conectado', { host: conn.connection.host })
        return conn
      })
      .catch((err) => {
        connecting = null
        logger.error('Erro ao conectar ao MongoDB', { error: String(err) })
        throw err
      })
  }
  return connecting
}
