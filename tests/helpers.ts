import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, inject } from 'vitest'
import mongoose from 'mongoose'
import request from 'supertest'
import type { Express } from 'express'
import { createApp } from '../src/app'

export function useTestApp() {
  const ctx = {} as { app: Express }

  beforeAll(async () => {
    await mongoose.connect(inject('mongoUri'), { dbName: `test_${randomUUID().slice(0, 8)}` })
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()))
    ctx.app = createApp()
  })

  afterEach(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})))
  })

  afterAll(async () => {
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  })

  return ctx
}

export function authed(app: Express, token: string) {
  const auth = { Authorization: `Bearer ${token}` }
  return {
    get: (url: string) => request(app).get(url).set(auth),
    post: (url: string, body?: object) => request(app).post(url).set(auth).send(body),
    put: (url: string, body?: object) => request(app).put(url).set(auth).send(body),
    delete: (url: string) => request(app).delete(url).set(auth),
  }
}

export async function login(app: Express, email = 'ana@test.com') {
  const res = await request(app).post('/api/auth/dev').send({ email, name: 'Teste' })
  if (res.status !== 200) throw new Error(`login falhou: ${res.status} ${JSON.stringify(res.body)}`)
  return { token: res.body.data.token as string, user: res.body.data.user, api: authed(app, res.body.data.token) }
}

export type Api = ReturnType<typeof authed>

export async function createTx(api: Api, overrides: Record<string, unknown> = {}) {
  const res = await api.post('/api/transactions', {
    date: '2026-03-10',
    description: 'Mercado',
    amountCents: 10_000,
    type: 'expense',
    ...overrides,
  })
  if (res.status !== 201) throw new Error(`createTx falhou: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.data
}
