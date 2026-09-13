import { Types } from 'mongoose'
import { Category, type CategoryDoc } from '../models/Category'
import { isDuplicateKeyError, notFound } from '../lib/errors'

export const DEFAULT_CATEGORIES = [
  { name: 'Salário', color: '#00C853', icon: '💰' },
  { name: 'Alimentação', color: '#FF6D00', icon: '🍽️' },
  { name: 'Transporte', color: '#2962FF', icon: '🚗' },
  { name: 'Saúde', color: '#D50000', icon: '🏥' },
  { name: 'Moradia', color: '#AA00FF', icon: '🏠' },
  { name: 'Lazer', color: '#FF6F00', icon: '🎮' },
  { name: 'Outros', color: '#6B7280', icon: '📦' },
]

export const FALLBACK_CATEGORY = 'Outros'

/**
 * Cria as categorias padrão de forma idempotente.
 * Pode ser chamada em paralelo (várias telas carregando ao mesmo tempo) sem duplicar.
 */
export async function ensureDefaultCategories(userId: string | Types.ObjectId): Promise<void> {
  const uid = new Types.ObjectId(String(userId))
  try {
    await Category.bulkWrite(
      DEFAULT_CATEGORIES.map((c) => ({
        updateOne: {
          filter: { userId: uid, name: c.name },
          update: { $setOnInsert: { ...c, userId: uid, isDefault: true } },
          upsert: true,
        },
      })),
      { ordered: false }
    )
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err
  }
}

export type CategoryDTO = {
  id: string
  name: string
  color: string
  icon: string | null
  description: string | null
  isDefault: boolean
}

export function toCategoryDTO(c: CategoryDoc): CategoryDTO {
  return {
    id: c._id.toString(),
    name: c.name,
    color: c.color ?? '#6B7280',
    icon: c.icon ?? null,
    description: c.description ?? null,
    isDefault: Boolean(c.isDefault),
  }
}

export async function categoryMap(userId: string): Promise<Map<string, CategoryDTO>> {
  const categories = await Category.find({ userId }).lean<CategoryDoc[]>()
  return new Map(categories.map((c) => [c._id.toString(), toCategoryDTO(c)]))
}

export async function assertCategoryOwnership(userId: string, categoryId: string | null | undefined) {
  if (!categoryId) return
  const exists = await Category.exists({ _id: categoryId, userId })
  if (!exists) throw notFound('Categoria não encontrada')
}
