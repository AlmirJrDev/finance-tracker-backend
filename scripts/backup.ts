/**
 * Backup e restauração do banco em arquivos JSON (EJSON canônico, preserva ObjectId, Decimal128 e datas).
 * O plano gratuito do Atlas não tem snapshots, então rode isto antes de qualquer migração.
 *
 *   npm run db:backup                              -> salva em backups/<data-hora>/
 *   npm run db:restore -- backups/<pasta> --confirm -> APAGA as coleções do banco e restaura a pasta
 */
import 'dotenv/config'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import mongoose from 'mongoose'
import type { Db } from 'mongodb'

const { EJSON } = mongoose.mongo.BSON

export async function backupDb(db: Db, dir: string): Promise<Record<string, number>> {
  mkdirSync(dir, { recursive: true })
  const counts: Record<string, number> = {}
  const collections = await db.listCollections({}, { nameOnly: true }).toArray()

  for (const { name } of collections) {
    if (name.startsWith('system.')) continue
    const docs = await db.collection(name).find().toArray()
    writeFileSync(path.join(dir, `${name}.json`), EJSON.stringify(docs, undefined, 0, { relaxed: false }))
    counts[name] = docs.length
  }
  writeFileSync(path.join(dir, '_manifest.json'), JSON.stringify({ database: db.databaseName, createdAt: new Date().toISOString(), counts }, null, 2))
  return counts
}

export async function restoreDb(db: Db, dir: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'))

  for (const file of files) {
    const name = file.replace(/\.json$/, '')
    const docs = EJSON.parse(readFileSync(path.join(dir, file), 'utf8'), { relaxed: false }) as Record<string, unknown>[]
    await db.collection(name).deleteMany({})
    if (docs.length) await db.collection(name).insertMany(docs)
    counts[name] = docs.length
  }
  return counts
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('Defina MONGODB_URI no .env')

  await mongoose.connect(uri)
  const db = mongoose.connection.db!
  try {
    if (command === 'backup') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const dir = path.resolve(__dirname, '../backups', stamp)
      const counts = await backupDb(db, dir)
      console.log(`Backup de "${db.databaseName}" salvo em ${dir}`)
      console.table(counts)
    } else if (command === 'restore') {
      const dir = rest.find((a) => !a.startsWith('--'))
      if (!dir) throw new Error('Informe a pasta do backup')
      if (!rest.includes('--confirm')) {
        throw new Error(`Isto apaga as coleções de "${db.databaseName}" e restaura ${dir}. Rode de novo com --confirm.`)
      }
      console.table(await restoreDb(db, path.resolve(dir)))
      console.log('Restauração concluída.')
    } else {
      throw new Error('Uso: backup | restore <pasta> --confirm')
    }
  } finally {
    await mongoose.disconnect()
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message ?? err)
    process.exit(1)
  })
}
