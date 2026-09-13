import { describe, expect, it } from 'vitest'
import { addDays, addMonths, isValidDate, monthRange, weekday } from '../src/lib/dates'
import { occurrencesInMonth } from '../src/services/recurrence'

describe('datas', () => {
  it('valida dias reais do calendário', () => {
    expect(isValidDate('2026-02-28')).toBe(true)
    expect(isValidDate('2028-02-29')).toBe(true)
    expect(isValidDate('2026-02-29')).toBe(false)
    expect(isValidDate('2026-04-31')).toBe(false)
    expect(isValidDate('2026-4-01')).toBe(false)
  })

  it('soma meses e dias atravessando o ano', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(monthRange('2026-11', '2027-02')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02'])
  })

  it('calcula o dia da semana sem depender do fuso', () => {
    expect(weekday('2026-09-13')).toBe(0) // domingo
    expect(weekday('2026-09-18')).toBe(5) // sexta
  })
})

describe('occurrencesInMonth', () => {
  it('mensal no dia 31 cai no último dia de fevereiro', () => {
    const rule = { frequency: 'monthly' as const, dayOfMonth: 31, startDate: '2026-01-01' }
    expect(occurrencesInMonth(rule, '2026-02')).toEqual(['2026-02-28'])
    expect(occurrencesInMonth(rule, '2026-03')).toEqual(['2026-03-31'])
  })

  it('semanal gera todas as ocorrências do dia da semana', () => {
    const rule = { frequency: 'weekly' as const, dayOfWeek: 1, startDate: '2026-01-01' }
    expect(occurrencesInMonth(rule, '2026-09')).toEqual(['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'])
  })

  it('respeita data inicial e final dentro do mês', () => {
    const rule = { frequency: 'daily' as const, startDate: '2026-09-10', endDate: '2026-09-12' }
    expect(occurrencesInMonth(rule, '2026-09')).toEqual(['2026-09-10', '2026-09-11', '2026-09-12'])
    expect(occurrencesInMonth(rule, '2026-10')).toEqual([])
    expect(occurrencesInMonth({ ...rule, startDate: '2026-11-01', endDate: null }, '2026-10')).toEqual([])
  })
})
