import { Router } from 'express'
import { Types } from 'mongoose'
import { z } from 'zod'
import { Account, ACCOUNT_TYPES, type AccountDoc } from '../models/Account'
import { MAX_AMOUNT_CENTS, Transaction } from '../models/Transaction'
import { RecurringTransaction } from '../models/RecurringTransaction'
import { accountBalances, ensureDefaultAccount, toAccountDTO } from '../services/accounts'
import { balanceBefore } from '../services/summary'
import { addDays, isValidDate } from '../lib/dates'
import { AppError, badRequest, notFound } from '../lib/errors'
import { asyncHandler, currentUserId, objectIdSchema, parseId, userToday } from '../lib/http'
import { toTransactionDTO } from './transactions'
import { categoryMap } from '../services/categories'

const router = Router()

const dateSchema = z.string().refine(isValidDate, 'Data inválida (use AAAA-MM-DD)')

const bodySchema = z.object({
  name: z.string().trim().min(2).max(50),
  type: z.enum(ACCOUNT_TYPES).default('checking'),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Cor inválida (use #RRGGBB)').optional(),
  icon: z.string().trim().max(16).nullable().optional(),
  isArchived: z.boolean().optional(),
})

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    await ensureDefaultAccount(userId)
    const [accounts, balances] = await Promise.all([
      Account.find({ userId }).sort({ isArchived: 1, isDefault: -1, name: 1 }).collation({ locale: 'pt' }).lean<AccountDoc[]>(),
      accountBalances(userId, userToday(req)),
    ])
    res.json({
      success: true,
      data: accounts.map((a) => ({
        ...toAccountDTO(a),
        ...(balances.get(a._id.toString()) ?? { balanceCents: 0, projectedBalanceCents: 0, transactionCount: 0 }),
      })),
    })
  })
)

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const body = bodySchema.parse(req.body)
    await ensureDefaultAccount(userId)
    const created = await Account.create({ ...body, userId, isDefault: false })
    res.status(201).json({ success: true, data: { ...toAccountDTO(created.toObject() as AccountDoc), balanceCents: 0, projectedBalanceCents: 0, transactionCount: 0 } })
  })
)

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const body = bodySchema.partial().extend({ isDefault: z.literal(true).optional() }).parse(req.body)
    const account = await Account.findOne({ _id: parseId(req.params.id), userId })
    if (!account) throw notFound('Conta não encontrada')

    if (body.isArchived && account.isDefault) throw badRequest('Escolha outra conta padrão antes de arquivar esta')
    if (body.isDefault) {
      if (account.isArchived && body.isArchived !== false) throw badRequest('Uma conta arquivada não pode ser a padrão')
      await Account.updateMany({ userId, _id: { $ne: account._id } }, { $set: { isDefault: false } })
    }

    account.set(body)
    await account.save()
    res.json({ success: true, data: toAccountDTO(account.toObject() as AccountDoc) })
  })
)

/**
 * Remove uma conta. Se ela tiver lançamentos, é preciso informar ?moveTo=<conta>
 * para onde eles vão (transferências para essa mesma conta são excluídas).
 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const account = await Account.findOne({ _id: parseId(req.params.id), userId })
    if (!account) throw notFound('Conta não encontrada')
    if (account.isDefault) throw new AppError(403, 'FORBIDDEN', 'A conta padrão não pode ser removida.')

    const [txCount, recurringCount] = await Promise.all([
      Transaction.countDocuments({ userId, accountId: account._id }),
      RecurringTransaction.countDocuments({ userId, accountId: account._id }),
    ])

    let moved = 0
    if (txCount + recurringCount > 0) {
      const moveTo = typeof req.query.moveTo === 'string' ? parseId(req.query.moveTo) : null
      if (!moveTo) {
        throw new AppError(409, 'ACCOUNT_NOT_EMPTY', 'A conta tem lançamentos. Informe para qual conta movê-los.', {
          transactionCount: txCount,
          recurringCount,
        })
      }
      if (moveTo === account._id.toString()) throw badRequest('Escolha outra conta de destino')
      const target = await Account.exists({ _id: moveTo, userId })
      if (!target) throw notFound('Conta de destino não encontrada')

      // Transferências entre a conta removida e o destino deixariam de fazer sentido
      const pairs = await Transaction.find({ userId, accountId: account._id, transferId: { $exists: true } }).distinct('transferId')
      const selfTransfers = await Transaction.find({ userId, transferId: { $in: pairs }, accountId: new Types.ObjectId(moveTo) }).distinct('transferId')
      if (selfTransfers.length) await Transaction.deleteMany({ userId, transferId: { $in: selfTransfers } })

      const result = await Transaction.updateMany({ userId, accountId: account._id }, { $set: { accountId: moveTo } })
      await RecurringTransaction.updateMany({ userId, accountId: account._id }, { $set: { accountId: moveTo } })
      moved = result.modifiedCount
    }

    await account.deleteOne()
    res.json({ success: true, data: { movedCount: moved } })
  })
)

/**
 * Ajusta o saldo da conta para um valor informado, criando um lançamento de ajuste
 * (não conta como receita nem despesa). Ex.: saldo inicial ou correção pelo extrato.
 */
router.post(
  '/:id/adjust',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const accountId = parseId(req.params.id)
    const body = z
      .object({
        balanceCents: z.number().int().min(-MAX_AMOUNT_CENTS).max(MAX_AMOUNT_CENTS),
        date: dateSchema.optional(),
        description: z.string().trim().min(2).max(200).default('Ajuste de saldo'),
      })
      .parse(req.body)
    if (!(await Account.exists({ _id: accountId, userId }))) throw notFound('Conta não encontrada')

    const date = body.date ?? userToday(req)
    // Saldo da conta ao fim do dia informado
    const current = await balanceBefore({ userId, accountId }, addDays(date, 1))
    const diff = body.balanceCents - current.all
    if (diff === 0) return res.json({ success: true, data: null, message: 'O saldo já está nesse valor.' })

    const created = await Transaction.create({
      userId,
      accountId,
      date,
      description: body.description,
      amountCents: Math.abs(diff),
      type: diff > 0 ? 'income' : 'expense',
      kind: 'adjustment',
      status: 'paid',
    })
    res.status(201).json({ success: true, data: toTransactionDTO(created.toObject(), await categoryMap(userId)) })
  })
)

/** Transferência entre duas contas do usuário: cria uma saída e uma entrada ligadas. */
router.post(
  '/transfers',
  asyncHandler(async (req, res) => {
    const userId = currentUserId(req)
    const body = z
      .object({
        fromAccountId: objectIdSchema,
        toAccountId: objectIdSchema,
        amountCents: z.number().int('amountCents deve ser inteiro (centavos)').positive().max(MAX_AMOUNT_CENTS),
        date: dateSchema,
        description: z.string().trim().min(2).max(200).optional(),
        note: z.string().trim().max(500).nullable().optional(),
        status: z.enum(['paid', 'pending']).optional(),
      })
      .refine((b) => b.fromAccountId !== b.toAccountId, { message: 'As contas precisam ser diferentes', path: ['toAccountId'] })
      .parse(req.body)

    const accounts = await Account.find({ userId, _id: { $in: [body.fromAccountId, body.toAccountId] } }).lean<AccountDoc[]>()
    const from = accounts.find((a) => a._id.toString() === body.fromAccountId)
    const to = accounts.find((a) => a._id.toString() === body.toAccountId)
    if (!from || !to) throw notFound('Conta não encontrada')

    const transferId = new Types.ObjectId()
    const status = body.status ?? (body.date > userToday(req) ? 'pending' : 'paid')
    const base = { userId, date: body.date, amountCents: body.amountCents, kind: 'transfer', transferId, status, note: body.note ?? undefined }
    const [out, inn] = await Transaction.insertMany([
      { ...base, accountId: from._id, type: 'expense', description: body.description ?? `Transferência para ${to.name}` },
      { ...base, accountId: to._id, type: 'income', description: body.description ?? `Transferência de ${from.name}` },
    ])

    const categories = await categoryMap(userId)
    res.status(201).json({
      success: true,
      data: { transferId: transferId.toString(), from: toTransactionDTO(out.toObject(), categories), to: toTransactionDTO(inn.toObject(), categories) },
    })
  })
)

export default router
