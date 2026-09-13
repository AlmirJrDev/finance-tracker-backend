import { afterEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { googleVerifier } from '../src/routes/auth'
import { authed, useTestApp } from './helpers'

const ctx = useTestApp()

describe('autenticação', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exige token nas rotas protegidas', async () => {
    const res = await request(ctx.app).get('/api/transactions').expect(401)
    expect(res.body.error).toBe('UNAUTHORIZED')
  })

  it('diferencia token expirado para o front pedir novo login', async () => {
    const token = jwt.sign({ userId: '507f1f77bcf86cd799439011' }, process.env.JWT_SECRET!, { expiresIn: -10 })
    const res = await authed(ctx.app, token).get('/api/transactions').expect(401)
    expect(res.body.error).toBe('TOKEN_EXPIRED')
  })

  it('login com Google cria o usuário, as categorias e devolve a expiração', async () => {
    vi.spyOn(googleVerifier, 'verify').mockResolvedValue({
      googleId: 'g-123',
      email: 'Almir@Example.com',
      name: 'Almir',
      avatar: 'https://example.com/a.png',
    })

    const res = await request(ctx.app).post('/api/auth/google').send({ idToken: 'fake' }).expect(200)
    expect(res.body.data.user).toMatchObject({ email: 'almir@example.com', name: 'Almir' })
    expect(new Date(res.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000)

    const api = authed(ctx.app, res.body.data.token)
    expect((await api.get('/api/categories')).body.data).toHaveLength(7)

    // Segundo login não duplica o usuário
    const again = await request(ctx.app).post('/api/auth/google').send({ idToken: 'fake' }).expect(200)
    expect(again.body.data.user.id).toBe(res.body.data.user.id)
  })

  it('devolve 401 claro quando o token do Google é inválido', async () => {
    const res = await request(ctx.app).post('/api/auth/google').send({ idToken: 'invalido' }).expect(401)
    expect(res.body.error).toBe('INVALID_GOOGLE_TOKEN')
  })
})
