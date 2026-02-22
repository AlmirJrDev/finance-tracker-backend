const mongoose = require('mongoose')
const logger = require('../../src/utils/logger')

// Cache da conexão entre invocações serverless
let cachedConnection = null

const connectDB = async () => {
  // Se já tem conexão ativa, reutilizar
  if (cachedConnection && mongoose.connection.readyState === 1) {
    return cachedConnection
  }

  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 10,
      minPoolSize: 0,
      maxIdleTimeMS: 10000,
      socketTimeoutMS: 20000,
    })

    cachedConnection = conn
    logger.info(`MongoDB conectado: ${conn.connection.host}`)
    return conn
  } catch (error) {
    logger.error('Erro ao conectar ao MongoDB:', error)
    throw error
  }
}

module.exports = connectDB