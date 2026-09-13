import 'dotenv/config'
import { createApp } from './app'
import { env } from './config/env'
import { connectDB } from './lib/db'
import { logger } from './lib/logger'

const app = createApp()

// Na Vercel o arquivo é importado (serverless); localmente sobe o servidor.
if (require.main === module) {
  const { PORT, NODE_ENV } = env()
  connectDB()
    .then(() => app.listen(PORT, () => logger.info(`Servidor rodando na porta ${PORT} [${NODE_ENV}]`)))
    .catch(() => process.exit(1))
}

export default app
