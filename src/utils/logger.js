const winston = require('winston')

const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
  }),
]

// Só usar arquivo em desenvolvimento (Vercel não tem sistema de arquivos gravável)
if (process.env.NODE_ENV !== 'production') {
  const fs = require('fs')
  if (!fs.existsSync('logs')) fs.mkdirSync('logs')
  transports.push(new winston.transports.File({ filename: 'logs/error.log', level: 'error' }))
  transports.push(new winston.transports.File({ filename: 'logs/combined.log' }))
}

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'warn' : 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports,
})

module.exports = logger