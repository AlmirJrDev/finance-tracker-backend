import { describe, expect, it } from 'vitest'
import { createTx, login, useTestApp } from './helpers'

const ctx = useTestApp()

describe('transações', () => {
  it('cria, lista por mês, edita e remove', async () => {
    const { api } = await login(ctx.app)
    const tx = await createTx(api, { date: '2026-03-31', amountCents: 4590 })
    expect(tx).toMatchObject({ date: '2026-03-31', amountCents: 4590, type: 'expense', category: null })

    const march = await api.get('/api/transactions?month=2026-03').expect(200)
    expect(march.body.data).toHaveLength(1)
    const april = await api.get('/api/transactions?month=2026-04').expect(200)
    expect(april.body.data).toHaveLength(0)

    const updated = await api.put(`/api/transactions/${tx.id}`, { description: 'Feira', amountCents: 5000 }).expect(200)
    expect(updated.body.data).toMatchObject({ description: 'Feira', amountCents: 5000, date: '2026-03-31' })

    await api.delete(`/api/transactions/${tx.id}`).expect(200)
    await api.get(`/api/transactions/${tx.id}`).expect(404)
  })

  it('edita a categoria enviando o ID e devolve os dados da categoria', async () => {
    const { api } = await login(ctx.app)
    const categories = (await api.get('/api/categories').expect(200)).body.data
    const food = categories.find((c: { name: string }) => c.name === 'Alimentação')

    const tx = await createTx(api)
    const res = await api.put(`/api/transactions/${tx.id}`, { ...tx, categoryId: food.id }).expect(200)
    expect(res.body.data.category).toMatchObject({ id: food.id, name: 'Alimentação' })
  })

  it('rejeita valores quebrados, datas inexistentes e categoria de outro usuário', async () => {
    const ana = await login(ctx.app, 'ana@test.com')
    const bia = await login(ctx.app, 'bia@test.com')
    const biaCategory = (await bia.api.get('/api/categories')).body.data[0]

    const base = { date: '2026-03-10', description: 'X teste', amountCents: 100, type: 'expense' }
    await ana.api.post('/api/transactions', { ...base, amountCents: 10.5 }).expect(400)
    await ana.api.post('/api/transactions', { ...base, date: '2026-02-30' }).expect(400)
    await ana.api.post('/api/transactions', { ...base, type: 'saída' }).expect(400)
    await ana.api.post('/api/transactions', { ...base, categoryId: biaCategory.id }).expect(404)
    await ana.api.get('/api/transactions/abc').expect(400)
  })

  it('isola os dados entre usuários', async () => {
    const ana = await login(ctx.app, 'ana@test.com')
    const bia = await login(ctx.app, 'bia@test.com')
    const tx = await createTx(ana.api)

    await bia.api.get(`/api/transactions/${tx.id}`).expect(404)
    await bia.api.put(`/api/transactions/${tx.id}`, { amountCents: 1 }).expect(404)
    await bia.api.delete(`/api/transactions/${tx.id}`).expect(404)
    expect((await bia.api.get('/api/transactions')).body.data).toHaveLength(0)
  })

  it('filtra por texto e limita o tamanho da página', async () => {
    const { api } = await login(ctx.app)
    await createTx(api, { description: 'iFood almoço' })
    await createTx(api, { description: 'Uber' })

    const res = await api.get('/api/transactions?q=ifood').expect(200)
    expect(res.body.data.map((t: { description: string }) => t.description)).toEqual(['iFood almoço'])
    await api.get('/api/transactions?limit=100000').expect(400)
  })
})
