import { Types } from 'mongoose'
import { Account, type AccountType } from '../models/Account'
import { BankConnection, type BankConnectionDoc } from '../models/BankConnection'
import { Category } from '../models/Category'
import { Transaction } from '../models/Transaction'
import { addDays, todayIn } from '../lib/dates'
import { isDuplicateKeyError } from '../lib/errors'
import { logger } from '../lib/logger'
import { pluggyApi, type PluggyAccount, type PluggyTransaction } from '../lib/pluggy'
import { isPending, signedAmount } from './summary'

const TIMEZONE = 'America/Sao_Paulo'

const dateInSaoPaulo = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' })

/** A Pluggy manda a data em UTC; o dia que vale é o de Brasília. */
export function pluggyDate(iso: string): string {
  return dateInSaoPaulo.format(new Date(iso))
}

export function accountTypeFor(pa: Pick<PluggyAccount, 'type' | 'subtype'>): AccountType {
  if (pa.subtype === 'CREDIT_CARD' || pa.type === 'CREDIT') return 'credit_card'
  if (pa.subtype === 'SAVINGS_ACCOUNT') return 'savings'
  if (pa.subtype === 'CHECKING_ACCOUNT' || pa.type === 'BANK') return 'checking'
  return 'other'
}

/** Pagamento de fatura, movimentação entre contas do titular e aplicações não são gasto nem receita. */
export function isInternalMovement(tx: Pick<PluggyTransaction, 'description' | 'category'>): boolean {
  const category = (tx.category ?? '').toLowerCase()
  const description = tx.description.toLowerCase()
  return (
    /credit card payment|same (person|ownership)|investment/.test(category) ||
    /pagamento (recebido|de fatura|da fatura|fatura)|pgto\.? fatura|aplica[cç][aã]o|resgate/.test(description)
  )
}

const CATEGORY_RULES: [RegExp, string][] = [
  [/salary|payroll|wage|sal[aá]rio/, 'Salário'],
  [/food|grocer|restaurant|eating|supermarket|delivery|ifood|mercado|padaria/, 'Alimentação'],
  [/transport|taxi|ride|gas station|fuel|parking|toll|uber|99app|combust/, 'Transporte'],
  [/health|pharmac|drugstore|hospital|medical|dentist|farm[aá]cia|drogaria/, 'Saúde'],
  [/housing|rent|utilit|electric|water|internet|telecom|condo|aluguel|energia/, 'Moradia'],
  [/leisure|entertainment|streaming|travel|sport|game|culture|netflix|spotify|cinema/, 'Lazer'],
]

function suggestCategory(tx: PluggyTransaction, categoryIdByName: Map<string, Types.ObjectId>): Types.ObjectId | null {
  const text = `${tx.category ?? ''} ${tx.description}`.toLowerCase()
  for (const [pattern, name] of CATEGORY_RULES) {
    if (pattern.test(text)) return categoryIdByName.get(name.toLowerCase()) ?? null
  }
  return null
}

async function uniqueAccountName(userId: Types.ObjectId, base: string): Promise<string> {
  const name = base.slice(0, 46)
  for (let i = 1; i < 20; i++) {
    const candidate = i === 1 ? name : `${name} ${i}`
    const exists = await Account.exists({ userId, name: candidate }).collation({ locale: 'pt', strength: 1 })
    if (!exists) return candidate
  }
  return `${name} ${Date.now() % 10000}`
}

async function ensureAccount(connection: BankConnectionDoc, pa: PluggyAccount) {
  const existing = await Account.findOne({ userId: connection.userId, 'provider.accountId': pa.id })
  if (existing) return existing
  const label = pa.marketingName || pa.name || (accountTypeFor(pa) === 'credit_card' ? 'Cartão' : 'Conta')
  return Account.create({
    userId: connection.userId,
    name: await uniqueAccountName(connection.userId, `${connection.connectorName ?? 'Banco'} ${label}`.trim()),
    type: accountTypeFor(pa),
    color: '#8A05BE',
    provider: {
      name: 'pluggy',
      itemId: connection.itemId,
      accountId: pa.id,
      connectorName: connection.connectorName,
      importFrom: connection.importFrom,
    },
  })
}

/**
 * Deixa o saldo pago da conta igual ao do banco com um único lançamento de ajuste, datado
 * na véspera do início da importação (representa tudo que aconteceu antes).
 */
async function reconcileBalance(userId: Types.ObjectId, accountId: Types.ObjectId, pa: PluggyAccount, importFrom: string, today: string) {
  const bankCents = Math.round(pa.balance * 100)
  // Cartão: a Pluggy informa o valor devido (positivo); no app, dívida é saldo negativo
  const target = accountTypeFor(pa) === 'credit_card' ? -bankCents : bankCents
  const externalId = `balance:${pa.id}`

  const [row] = await Transaction.aggregate<{ total: number }>([
    { $match: { userId, accountId, date: { $lte: today }, 'external.id': { $ne: externalId } } },
    { $group: { _id: null, total: { $sum: { $cond: [isPending, 0, signedAmount] } } } },
  ])
  const diff = target - (row?.total ?? 0)
  const filter = { userId, 'external.provider': 'pluggy', 'external.id': externalId }

  if (diff === 0) {
    await Transaction.deleteOne(filter)
    return 0
  }
  await Transaction.updateOne(
    filter,
    {
      $set: {
        accountId,
        date: addDays(importFrom, -1),
        description: 'Saldo antes da sincronização',
        amountCents: Math.abs(diff),
        type: diff > 0 ? 'income' : 'expense',
        kind: 'adjustment',
        status: 'paid',
        updatedAt: new Date(),
      },
      $setOnInsert: { userId, external: { provider: 'pluggy', id: externalId }, createdAt: new Date() },
    },
    { upsert: true, timestamps: false }
  )
  return diff
}

export type SyncResult = { accounts: number; created: number; updated: number; skipped: number }

export async function syncConnection(connectionId: string | Types.ObjectId): Promise<SyncResult> {
  const connection = await BankConnection.findById(connectionId).lean<BankConnectionDoc>()
  if (!connection) throw new Error('Conexão não encontrada')
  const today = todayIn(TIMEZONE)
  const result: SyncResult = { accounts: 0, created: 0, updated: 0, skipped: 0 }

  try {
    const item = await pluggyApi.getItem(connection.itemId)
    connection.connectorName = item.connector?.name ?? connection.connectorName
    await BankConnection.updateOne({ _id: connection._id }, { $set: { status: item.status, connectorId: item.connector?.id, connectorName: connection.connectorName } })

    const categories = await Category.find({ userId: connection.userId }, { name: 1 }).lean()
    const categoryIdByName = new Map(categories.map((c) => [c.name.toLowerCase(), c._id]))

    for (const pa of await pluggyApi.listAccounts(connection.itemId)) {
      const account = await ensureAccount(connection, pa)
      result.accounts++

      const transactions = await pluggyApi.listTransactions(pa.id, connection.importFrom)
      const now = new Date()
      const ops = transactions.flatMap((tx) => {
        const amountCents = Math.round(Math.abs(tx.amount) * 100)
        const date = pluggyDate(tx.date)
        if (amountCents === 0 || date < connection.importFrom) {
          result.skipped++
          return []
        }
        return [
          {
            updateOne: {
              filter: { userId: connection.userId, 'external.provider': 'pluggy', 'external.id': tx.id },
              update: {
                // Dados do banco sempre atualizados; categoria e tipo de movimento o usuário pode mudar
                $set: {
                  accountId: account._id,
                  date,
                  description: (tx.description || tx.descriptionRaw || 'Transação').slice(0, 200).padEnd(2, '.'),
                  amountCents,
                  type: tx.type === 'CREDIT' ? ('income' as const) : ('expense' as const),
                  status: 'paid' as const,
                  'external.category': tx.category ?? null,
                  updatedAt: now,
                },
                $setOnInsert: {
                  userId: connection.userId,
                  'external.provider': 'pluggy',
                  'external.id': tx.id,
                  kind: isInternalMovement(tx) ? ('transfer' as const) : ('regular' as const),
                  categoryId: isInternalMovement(tx) ? null : suggestCategory(tx, categoryIdByName),
                  recurringId: null,
                  createdAt: now,
                },
              },
              upsert: true,
              timestamps: false,
            },
          },
        ]
      })

      if (ops.length) {
        try {
          const write = await Transaction.bulkWrite(ops, { ordered: false })
          result.created += write.upsertedCount
          result.updated += write.modifiedCount
        } catch (err) {
          if (!isDuplicateKeyError(err)) throw err
        }
      }

      await reconcileBalance(connection.userId, account._id, pa, connection.importFrom, today)
      await Account.updateOne({ _id: account._id }, { $set: { 'provider.lastSyncAt': new Date(), 'provider.connectorName': connection.connectorName } })
    }

    await BankConnection.updateOne({ _id: connection._id }, { $set: { lastSyncAt: new Date(), lastSyncError: null } })
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error('Falha ao sincronizar conexão bancária', { connectionId: String(connection._id), error: message })
    await BankConnection.updateOne({ _id: connection._id }, { $set: { lastSyncError: message } })
    throw err
  }
}
