/**
 * Datas de transação são strings "YYYY-MM-DD" (dia do calendário, sem fuso).
 * Meses são strings "YYYY-MM". Nunca usamos Date local para regra de negócio,
 * então o resultado é o mesmo no servidor (UTC) e no navegador (America/Sao_Paulo).
 */

export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export const pad = (n: number) => String(n).padStart(2, '0')

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function toDateStr(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`
}

export function toMonthStr(year: number, month: number): string {
  return `${year}-${pad(month)}`
}

export function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  return d <= daysInMonth(y, m)
}

export function parseMonth(ym: string): { year: number; month: number } {
  if (!MONTH_RE.test(ym)) throw new Error(`Mês inválido: ${ym}`)
  const [year, month] = ym.split('-').map(Number)
  return { year, month }
}

export function monthBounds(ym: string): { from: string; to: string } {
  const { year, month } = parseMonth(ym)
  return { from: `${ym}-01`, to: toDateStr(year, month, daysInMonth(year, month)) }
}

export function addMonths(ym: string, n: number): string {
  const { year, month } = parseMonth(ym)
  const index = year * 12 + (month - 1) + n
  return toMonthStr(Math.floor(index / 12), (index % 12) + 1)
}

/** Lista inclusiva de meses entre from e to. */
export function monthRange(from: string, to: string): string[] {
  const months: string[] = []
  for (let m = from; m <= to; m = addMonths(m, 1)) months.push(m)
  return months
}

/** Mesmo dia n meses depois, limitado ao último dia do mês (31/01 + 1 → 28/02). */
export function addMonthsToDate(date: string, n: number): string {
  const ym = addMonths(date.slice(0, 7), n)
  const { year, month } = parseMonth(ym)
  return toDateStr(year, month, Math.min(Number(date.slice(8, 10)), daysInMonth(year, month)))
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return toDateStr(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate())
}

/** 0 = domingo ... 6 = sábado */
export function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** Data de hoje no fuso informado, como "YYYY-MM-DD". */
export function todayIn(timeZone = 'America/Sao_Paulo'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}
