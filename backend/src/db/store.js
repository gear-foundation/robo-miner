import { JsonStore } from './jsonStore.js';
import { PostgresDocumentStore, PostgresStore } from './postgresStore.js';

export function createStore(config) {
  if (config.storeBackend === 'postgres') {
    return new PostgresStore({
      connectionString: config.databaseUrl,
      documentId: config.databaseDocumentId,
      schema: config.databaseSchema,
    });
  }
  return new JsonStore(config.dbFile);
}

export function createDocumentStore(config) {
  if (config.storeBackend !== 'postgres') return null;
  return new PostgresDocumentStore({
    connectionString: config.databaseUrl,
    schema: config.databaseSchema,
  });
}
