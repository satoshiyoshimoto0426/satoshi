/**
 * src/util/hash.ts の単体テスト(詳細設計書 §13「ユニット: ハッシュ」)。
 *
 * sha256 は items の contentHash(更新検知)、itemIdFor は Firestore の
 * ドキュメント ID に使われる。決定性が崩れると「毎回新着扱い」= 重複配信になる。
 */
import { describe, expect, it } from 'vitest';

import { itemIdFor, sha256 } from '../src/util/hash.js';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

describe('sha256', () => {
  it('16 進小文字 64 桁を返す', () => {
    expect(sha256('https://www.mhlw.go.jp/stf/newpage.html')).toMatch(HEX64);
    expect(sha256('')).toMatch(HEX64);
    expect(sha256('日本語の本文でも 64 桁')).toMatch(HEX64);
  });

  it('決定的である(同じ入力は常に同じ値)', () => {
    const input = '障害福祉サービス等報酬改定について';
    const first = sha256(input);
    for (let i = 0; i < 5; i++) {
      expect(sha256(input)).toBe(first);
    }
  });

  it('既知のテストベクタと一致する(UTF-8 として扱われている)', () => {
    // 空文字列の SHA-256(RFC 6234 のテストベクタ)。
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    // 'abc' の SHA-256。
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    // 日本語(UTF-8 バイト列)のハッシュ。latin1 等で解釈されると値が変わる。
    expect(sha256('あ')).toBe('dc5a4d3d82f7e15792959dc661538ae0e541ce66494516f5c9cfd9cd3308494d');
  });

  it('異なる入力は異なる値になる', () => {
    const values = [
      sha256('https://example.jp/a'),
      sha256('https://example.jp/b'),
      sha256('https://example.jp/a '),
      sha256('https://example.jp/A'),
      sha256(''),
    ];
    expect(new Set(values).size).toBe(values.length);
  });

  it('1 文字違いでも大きく変わる', () => {
    expect(sha256('報酬改定 2026')).not.toBe(sha256('報酬改定 2027'));
  });
});

describe('itemIdFor', () => {
  it('40 桁の 16 進小文字を返す', () => {
    expect(itemIdFor('https://www.mhlw.go.jp/stf/newpage.html')).toMatch(HEX40);
    expect(itemIdFor('https://www.mhlw.go.jp/stf/newpage.html')).toHaveLength(40);
  });

  it('sha256 の先頭 40 桁である', () => {
    const url = 'https://www.cfa.go.jp/policies/shougaijishien/';
    expect(itemIdFor(url)).toBe(sha256(url).slice(0, 40));
  });

  it('決定的である', () => {
    const url = 'https://www.mhlw.go.jp/stf/seisakunitsuite/index.html';
    expect(itemIdFor(url)).toBe(itemIdFor(url));
  });

  it('異なる正規化 URL は異なる ID になる', () => {
    const ids = [
      itemIdFor('https://example.jp/a'),
      itemIdFor('https://example.jp/b'),
      itemIdFor('https://example.jp/a?x=1'),
      itemIdFor('https://other.jp/a'),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
