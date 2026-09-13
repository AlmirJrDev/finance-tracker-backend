import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string
  }
}

export default async function setup(project: TestProject) {
  const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  project.provide('mongoUri', mongo.getUri())
  return async () => {
    await mongo.stop()
  }
}
