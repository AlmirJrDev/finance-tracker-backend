import { describe, expect, it } from 'vitest'
import { Category } from '../src/models/Category'
import { createTx, login, useTestApp } from './helpers'

const ctx = useTestApp()

describe('categorias', () => {
  it('cria as padrão só uma vez, mesmo com chamadas simultâneas', async () => {
    const { api, user } = await login(ctx.app)
    await Category.deleteMany({ userId: user.id })

    const responses = await Promise.all(Array.from({ length: 5 }, () => api.get('/api/categories')))
    responses.forEach((r) => expect(r.status).toBe(200))
    expect(await Category.countDocuments({ userId: user.id })).toBe(7)
  })

  it('aceita emoji composto como ícone', async () => {
    const { api } = await login(ctx.app)
    const res = await api.post('/api/categories', { name: 'Restaurantes', icon: '🍽️', color: '#112233' }).expect(201)
    expect(res.body.data).toMatchObject({ name: 'Restaurantes', icon: '🍽️', isDefault: false })
  })

  it('não permite nomes repetidos ignorando maiúsculas e acentos', async () => {
    const { api } = await login(ctx.app)
    await api.post('/api/categories', { name: 'saude' }).expect(409)
    await api.post('/api/categories', { name: 'LAZER' }).expect(409)
  })

  it('renomear reflete nas transações antigas', async () => {
    const { api } = await login(ctx.app)
    const cat = (await api.post('/api/categories', { name: 'Pets' })).body.data
    const tx = await createTx(api, { categoryId: cat.id })

    await api.put(`/api/categories/${cat.id}`, { name: 'Cachorro' }).expect(200)
    const res = await api.get(`/api/transactions/${tx.id}`)
    expect(res.body.data.category.name).toBe('Cachorro')
  })

  it('remover move as transações para Outros e protege as padrão', async () => {
    const { api } = await login(ctx.app)
    const categories = (await api.get('/api/categories')).body.data
    const outros = categories.find((c: { name: string }) => c.name === 'Outros')
    const cat = (await api.post('/api/categories', { name: 'Temporária' })).body.data
    const tx = await createTx(api, { categoryId: cat.id })

    const del = await api.delete(`/api/categories/${cat.id}`).expect(200)
    expect(del.body.data).toEqual({ movedTo: outros.id, movedCount: 1 })
    expect((await api.get(`/api/transactions/${tx.id}`)).body.data.categoryId).toBe(outros.id)

    await api.delete(`/api/categories/${outros.id}`).expect(403)
  })
})
