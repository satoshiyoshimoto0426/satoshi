/**
 * ハッシュ関連ユーティリティ。
 *
 * 用途: アイテム ID(正規化 URL 由来)と本文の更新検知(contentHash)。
 * 詳細設計書 §5.1。
 */

import { createHash } from 'node:crypto';

/** SHA-256 を 16 進小文字 64 桁で返す。入力は UTF-8 として扱う。 */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 正規化 URL からアイテム ID を作る。
 *
 * なぜ先頭 40 桁か: Firestore のドキュメント ID として十分に短く、かつ
 * 40 桁(160bit)あれば実運用の件数では衝突が事実上起きないため。
 */
export function itemIdFor(canonicalUrl: string): string {
  return sha256(canonicalUrl).slice(0, 40);
}
