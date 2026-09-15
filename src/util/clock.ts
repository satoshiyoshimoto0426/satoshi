/**
 * 現在時刻の取得口。
 *
 * なぜ: テストで時刻を固定できるようにするため、アプリ全体は `new Date()` /
 * `Date.now()` を直接呼ばず必ず `Clock` を経由する(モジュール契約 §絶対ルール5)。
 * 実時刻に触れてよいのはこのファイルだけ。
 */

import type { Clock } from '../types.js';

/** 実時刻を返す既定の時計。本番コードはこれを使う。 */
export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};

/**
 * 常に同じ時刻を返す時計(テスト用)。
 *
 * なぜ引数を検証するか: 不正な ISO 文字列を黙って Invalid Date として受け入れると、
 * テストが「なぜか日付が NaN になる」形で遠くで失敗して原因追跡が難しくなるため、
 * 生成時点で落とす。
 */
export function fixedClock(iso: string): Clock {
  const fixed = new Date(iso);
  if (Number.isNaN(fixed.getTime())) {
    throw new TypeError(`fixedClock: 不正な日時文字列です: ${iso}`);
  }
  const ms = fixed.getTime();
  return {
    // 呼び出しごとに新しい Date を返す。呼び出し側が変更しても固定値が壊れないようにするため。
    now(): Date {
      return new Date(ms);
    },
  };
}
