import { env } from '../config/env'
import { AppError } from './errors'

/** Conector do Meu Pluggy (conexão gratuita com as contas do próprio titular) */
export const MEU_PLUGGY_CONNECTOR_ID = 200

export type PluggyItem = {
  id: string
  status: string
  executionStatus?: string
  lastUpdatedAt?: string | null
  clientUserId?: string | null
  connector: { id: number; name: string; primaryColor?: string; imageUrl?: string }
  error?: { code?: string; message?: string } | null
}

export type PluggyAccount = {
  id: string
  itemId: string
  type: 'BANK' | 'CREDIT' | string
  subtype: string
  name: string
  marketingName?: string | null
  number?: string | null
  balance: number
  currencyCode?: string
}

export type PluggyTransaction = {
  id: string
  accountId: string
  description: string
  descriptionRaw?: string | null
  amount: number
  amountInAccountCurrency?: number | null
  currencyCode?: string
  date: string
  type: 'DEBIT' | 'CREDIT'
  status?: 'POSTED' | 'PENDING'
  category?: string | null
  categoryId?: string | null
  creditCardMetadata?: { installmentNumber?: number; totalInstallments?: number } | null
}

export function pluggyConfigured(): boolean {
  const e = env()
  return Boolean(e.PLUGGY_CLIENT_ID && e.PLUGGY_CLIENT_SECRET)
}

/** Aceita e-mails separados por vírgula, ponto e vírgula ou espaço, com ou sem aspas. */
export function parseAllowedEmails(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((e) => e.trim().replace(/^["']+|["']+$/g, '').toLowerCase())
    .filter((e) => e.includes('@'))
}

export function pluggyAllowedFor(email: string | undefined | null): boolean {
  if (!pluggyConfigured() || !email) return false
  return parseAllowedEmails(env().PLUGGY_ALLOWED_EMAILS).includes(email.trim().toLowerCase())
}

let cachedKey: { value: string; expiresAt: number } | null = null

async function apiKey(): Promise<string> {
  // A chave dura 2h; renova com folga
  if (cachedKey && cachedKey.expiresAt > Date.now()) return cachedKey.value
  const e = env()
  const res = await fetch(`${e.PLUGGY_API_URL}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: e.PLUGGY_CLIENT_ID, clientSecret: e.PLUGGY_CLIENT_SECRET }),
  })
  const body = (await res.json().catch(() => null)) as { apiKey?: string } | null
  if (!res.ok || !body?.apiKey) throw new AppError(502, 'PLUGGY_AUTH_FAILED', 'Não foi possível autenticar na Pluggy.')
  cachedKey = { value: body.apiKey, expiresAt: Date.now() + 100 * 60 * 1000 }
  return body.apiKey
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!pluggyConfigured()) throw new AppError(503, 'PLUGGY_DISABLED', 'Integração bancária não configurada.')
  const res = await fetch(`${env().PLUGGY_API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': await apiKey(), ...(init.headers ?? {}) },
  })
  if (res.status === 401) cachedKey = null
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const message = (body as { message?: string } | null)?.message ?? `Pluggy respondeu ${res.status}`
    throw new AppError(res.status === 404 ? 404 : 502, 'PLUGGY_ERROR', message)
  }
  return body as T
}

/**
 * Operações usadas pelo app. Fica num objeto para os testes poderem substituir
 * sem chamar a API real.
 */
export const pluggyApi = {
  async createConnectToken(options: { clientUserId: string; itemId?: string; webhookUrl?: string }) {
    const { itemId, ...rest } = options
    const body = await request<{ accessToken: string }>('/connect_token', {
      method: 'POST',
      body: JSON.stringify({ itemId, options: { ...rest, avoidDuplicates: true } }),
    })
    return body.accessToken
  },

  getItem: (itemId: string) => request<PluggyItem>(`/items/${itemId}`),

  async deleteItem(itemId: string) {
    await request(`/items/${itemId}`, { method: 'DELETE' })
  },

  async listAccounts(itemId: string) {
    const body = await request<{ results: PluggyAccount[] }>(`/accounts?itemId=${encodeURIComponent(itemId)}`)
    return body.results
  },

  /** Todas as transações da conta a partir de uma data (paginação por cursor). */
  async listTransactions(accountId: string, dateFrom: string) {
    const all: PluggyTransaction[] = []
    let query = `accountId=${encodeURIComponent(accountId)}&dateFrom=${dateFrom}`
    for (let page = 0; page < 100; page++) {
      const body = await request<{ results: PluggyTransaction[]; next?: string | null }>(`/v2/transactions?${query}`)
      all.push(...body.results)
      if (!body.next) break
      query = body.next.replace(/^\?/, '')
    }
    return all
  },
}
