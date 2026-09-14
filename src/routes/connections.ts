import { Router } from 'express'
import { z } from 'zod'
import { env } from '../config/env'
import { Account } from '../models/Account'
import { BankConnection, type BankConnectionDoc } from '../models/BankConnection'
import { Transaction } from '../models/Transaction'
import { syncConnection } from '../services/bank-sync'
import { isValidDate, todayIn } from '../lib/dates'
import { AppError, notFound } from '../lib/errors'
import { asyncHandler, currentUserId, parseId } from '../lib/http'
import { MEU_PLUGGY_CONNECTOR_ID, pluggyAllowedFor, pluggyApi, pluggyConfigured } from '../lib/pluggy'
import { logger } from '../lib/logger'
import type { Request } from 'express'

const router = Router()
export const webhookRouter = Router()

const MIN_SYNC_INTERVAL_MS = 2 * 60 * 1000

function assertAllowed(req: Request) {
  if (!pluggyConfigured()) throw new AppError(503, 'PLUGGY_DISABLED', 'Integração bancária não configurada.')
  if (!pluggyAllowedFor(req.user?.email)) {
    throw new AppError(403, 'PLUGGY_NOT_ALLOWED', 'A conexão bancária gratuita (Meu Pluggy) só pode ser usada pelo titular das contas.')
  }
}

async function toConnectionDTO(c: BankConnectionDoc) {
  const accounts = await Account.find({ userId: c.userId, 'provider.itemId': c.itemId }, { name: 1, type: 1 }).lean()
  return {
    id: c._id.toString(),
    provider: c.provider,
    itemId: c.itemId,
    connectorName: c.connectorName ?? null,
    status: c.status ?? null,
    importFrom: c.importFrom,
    lastSyncAt: c.lastSyncAt ?? null,
    lastSyncError: c.lastSyncError ?? null,
    accounts: accounts.map((a) => ({ id: a._id.toString(), name: a.name, type: a.type })),
  }
}

router.get(
  '/status',
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: { enabled: pluggyConfigured(), allowed: pluggyAllowedFor(req.user?.email), connectorId: MEU_PLUGGY_CONNECTOR_ID },
    })
  })
)

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const connections = await BankConnection.find({ userId: currentUserId(req) }).sort({ createdAt: 1 }).lean<BankConnectionDoc[]>()
    res.json({ success: true, data: await Promise.all(connections.map(toConnectionDTO)) })
  })
)

/** Token de curta duração para abrir o widget Pluggy Connect no navegador. */
router.post(
  '/connect-token',
  asyncHandler(async (req, res) => {
    assertAllowed(req)
    const { itemId } = z.object({ itemId: z.string().uuid().optional() }).parse(req.body ?? {})
    const publicUrl = env().API_PUBLIC_URL
    const accessToken = await pluggyApi.createConnectToken({
      clientUserId: currentUserId(req),
      itemId,
      webhookUrl: publicUrl ? `${publicUrl.replace(/\/$/, '')}/api/webhooks/pluggy` : undefined,
    })
    res.json({ success: true, data: { accessToken, connectorId: MEU_PLUGGY_CONNECTOR_ID } })
  })
)

/** Registra a conexão criada no widget e já faz a primeira sincronização. */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    assertAllowed(req)
    const userId = currentUserId(req)
    const body = z
      .object({
        itemId: z.string().uuid('itemId inválido'),
        importFrom: z.string().refine(isValidDate, 'Data inválida (use AAAA-MM-DD)').optional(),
      })
      .parse(req.body)

    const item = await pluggyApi.getItem(body.itemId)
    if (item.clientUserId && item.clientUserId !== userId) throw notFound('Conexão não encontrada')

    const existing = await BankConnection.findOne({ provider: 'pluggy', itemId: body.itemId }).lean<BankConnectionDoc>()
    if (existing && existing.userId.toString() !== userId) throw notFound('Conexão não encontrada')

    const importFrom = body.importFrom ?? `${todayIn('America/Sao_Paulo').slice(0, 7)}-01`
    const connection =
      existing ??
      (await BankConnection.create({
        userId,
        itemId: body.itemId,
        connectorId: item.connector?.id,
        connectorName: item.connector?.name,
        status: item.status,
        importFrom,
      }))

    let sync = null
    try {
      sync = await syncConnection(connection._id)
    } catch {
      // O erro fica salvo em lastSyncError e aparece na tela
    }
    const fresh = await BankConnection.findById(connection._id).lean<BankConnectionDoc>()
    res.status(existing ? 200 : 201).json({ success: true, data: { connection: await toConnectionDTO(fresh!), sync } })
  })
)

router.post(
  '/:id/sync',
  asyncHandler(async (req, res) => {
    assertAllowed(req)
    const connection = await BankConnection.findOne({ _id: parseId(req.params.id), userId: currentUserId(req) }).lean<BankConnectionDoc>()
    if (!connection) throw notFound('Conexão não encontrada')
    if (connection.lastSyncAt && Date.now() - new Date(connection.lastSyncAt).getTime() < MIN_SYNC_INTERVAL_MS) {
      throw new AppError(429, 'SYNC_TOO_SOON', 'Sincronizado há pouco. Tente de novo em alguns minutos.')
    }
    const sync = await syncConnection(connection._id)
    const fresh = await BankConnection.findById(connection._id).lean<BankConnectionDoc>()
    res.json({ success: true, data: { connection: await toConnectionDTO(fresh!), sync } })
  })
)

/**
 * Remove a conexão. Por padrão as contas e transações importadas ficam como manuais;
 * com ?deleteData=true os lançamentos vindos do banco e as contas criadas por ela são apagados.
 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const connection = await BankConnection.findOne({ _id: parseId(req.params.id), userId }).lean<BankConnectionDoc>()
    if (!connection) throw notFound('Conexão não encontrada')

    try {
      await pluggyApi.deleteItem(connection.itemId)
    } catch (err) {
      if (!(err instanceof AppError && err.statusCode === 404)) throw err
    }

    const accounts = await Account.find({ userId, 'provider.itemId': connection.itemId }, { _id: 1 }).lean()
    const accountIds = accounts.map((a) => a._id)
    let deletedTransactions = 0
    if (req.query.deleteData === 'true') {
      const del = await Transaction.deleteMany({ userId, accountId: { $in: accountIds }, 'external.provider': 'pluggy' })
      deletedTransactions = del.deletedCount
      const stillUsed = await Transaction.distinct('accountId', { userId, accountId: { $in: accountIds } })
      await Account.deleteMany({ userId, _id: { $in: accountIds, $nin: stillUsed }, isDefault: { $ne: true } })
      await Account.updateMany({ userId, _id: { $in: stillUsed } }, { $unset: { provider: '' } })
    } else {
      await Account.updateMany({ userId, _id: { $in: accountIds } }, { $unset: { provider: '' } })
    }
    await BankConnection.deleteOne({ _id: connection._id })
    res.json({ success: true, data: { deletedTransactions } })
  })
)

/**
 * Webhook da Pluggy. Não confia no conteúdo: só usa o itemId para buscar os dados
 * atualizados direto na API. Responde em até ~8s (a Pluggy exige 2xx em 10s).
 */
webhookRouter.post(
  '/pluggy',
  asyncHandler(async (req, res) => {
    const { event, itemId } = z.object({ event: z.string(), itemId: z.string().optional() }).passthrough().parse(req.body ?? {})
    const relevant = /^(item\/(created|updated|login_succeeded)|transactions\/(created|updated|deleted))$/.test(event)
    const connection = itemId && relevant ? await BankConnection.findOne({ provider: 'pluggy', itemId }).lean<BankConnectionDoc>() : null

    if (connection) {
      const sync = syncConnection(connection._id).catch((err) => logger.warn('Webhook: sincronização falhou', { itemId, error: String(err) }))
      await Promise.race([sync, new Promise((resolve) => setTimeout(resolve, 8000))])
    }
    res.json({ success: true })
  })
)

export default router
