export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message)
  }
}

export const notFound = (message: string) => new AppError(404, 'NOT_FOUND', message)
export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'VALIDATION_ERROR', message, details)

export function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: number; writeErrors?: { code?: number }[] }
  if (e.code === 11000) return true
  return Array.isArray(e.writeErrors) && e.writeErrors.length > 0 && e.writeErrors.every((w) => w.code === 11000)
}
