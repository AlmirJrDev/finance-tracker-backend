import { z } from 'zod'

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3001),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI é obrigatória'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET precisa de pelo menos 16 caracteres'),
  JWT_EXPIRES_IN: z.string().default('30d'),
  GOOGLE_CLIENT_ID: z.string().default(''),
  // Aceita várias origens separadas por vírgula
  FRONTEND_URL: z.string().default('http://localhost:3000'),
  // Login sem Google, apenas para desenvolvimento local
  ALLOW_DEV_LOGIN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
})

export type Env = z.infer<typeof schema>

let cached: Env | null = null

export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      throw new Error(`Variáveis de ambiente inválidas — ${issues}`)
    }
    cached = parsed.data
  }
  return cached
}

export function devLoginEnabled(): boolean {
  const e = env()
  return e.ALLOW_DEV_LOGIN && e.NODE_ENV !== 'production'
}
