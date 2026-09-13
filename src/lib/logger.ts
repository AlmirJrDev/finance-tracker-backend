type Level = 'debug' | 'info' | 'warn' | 'error'

// Log em JSON no stdout: funciona na Vercel (serverless) sem escrever arquivos.
function log(level: Level, message: string, meta?: Record<string, unknown>) {
  const nodeEnv = process.env.NODE_ENV
  if (nodeEnv === 'test' && level !== 'error') return
  if (level === 'debug' && nodeEnv === 'production') return

  const line = JSON.stringify({ level, message, ...meta, timestamp: new Date().toISOString() })
  if (level === 'error') console.error(line)
  else console.log(line)
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
}
