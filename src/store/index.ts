/**
 * Store の生成口。呼び出し側(context.ts / CLI)は実装の種類を意識せず
 * `createStore(runtime)` だけを使う。
 */
import { createFirestoreStore } from './firestore.js';
import { createMemoryStore } from './memory.js';
import type { RuntimeConfig, Store } from '../types.js';

/**
 * runtime.storeKind に従って Store 実装を選ぶ。
 * 'memory' はテストとローカルのドライラン用で、GCP 認証情報を一切必要としない。
 */
export function createStore(runtime: RuntimeConfig): Store {
  if (runtime.storeKind === 'memory') {
    return createMemoryStore();
  }
  return createFirestoreStore(runtime.gcpProjectId, runtime.firestoreDatabaseId);
}
