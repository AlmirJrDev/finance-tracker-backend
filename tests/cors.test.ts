import { describe, expect, it } from 'vitest'
import express from 'express'
import cors from 'cors'
import request from 'supertest'
import { corsOrigin } from '../src/app'

function appWith(frontendUrl: string) {
  const app = express()
  app.use(cors({ origin: corsOrigin(frontendUrl), credentials: true }))
  app.get('/', (_req, res) => res.json({ ok: true }))
  return app
}

const allowOrigin = async (frontendUrl: string, origin: string) =>
  (await request(appWith(frontendUrl)).get('/').set('Origin', origin)).headers['access-control-allow-origin']

describe('CORS', () => {
  it('ignora barra final e maiúsculas no FRONTEND_URL', async () => {
    expect(await allowOrigin('https://App.vercel.app/', 'https://app.vercel.app')).toBe('https://app.vercel.app')
  })

  it('aceita lista separada por vírgula e bloqueia o resto', async () => {
    const list = 'http://localhost:3000, https://app.vercel.app'
    expect(await allowOrigin(list, 'http://localhost:3000')).toBe('http://localhost:3000')
    expect(await allowOrigin(list, 'https://outro.com')).toBeUndefined()
  })

  it('"*" libera qualquer origem refletindo a origem recebida', async () => {
    expect(await allowOrigin('*', 'https://qualquer.com')).toBe('https://qualquer.com')
  })
})
