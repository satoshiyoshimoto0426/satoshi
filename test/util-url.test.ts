/**
 * src/util/url.ts の単体テスト(詳細設計書 §13「ユニット: URL 正規化」)。
 *
 * 検証の軸はモジュール契約 §src/util/url.ts の正規化規則 7 項目。
 * items の ID は正規化 URL の SHA-256 なので、ここが緩むと同じ記事を
 * 毎朝重複配信する(または新着を取りこぼす)という配信事故に直結する。
 */
import { describe, expect, it } from 'vitest';

import { canonicalizeUrl, hostOf, isHttpUrl, resolveUrl } from '../src/util/url.js';

describe('canonicalizeUrl', () => {
  describe('規則1: 相対 URL の絶対化', () => {
    it('base を与えるとルート相対パスを絶対化する', () => {
      expect(canonicalizeUrl('/stf/newpage.html', 'https://www.mhlw.go.jp/index.html')).toBe(
        'https://www.mhlw.go.jp/stf/newpage.html',
      );
    });

    it('base を与えると相対パス(../)を解決する', () => {
      expect(canonicalizeUrl('../content/001.pdf', 'https://www.mhlw.go.jp/stf/newpage.html')).toBe(
        'https://www.mhlw.go.jp/content/001.pdf',
      );
    });

    it('絶対 URL は base があっても base を無視する', () => {
      expect(canonicalizeUrl('https://www.cfa.go.jp/a', 'https://www.mhlw.go.jp/')).toBe(
        'https://www.cfa.go.jp/a',
      );
    });

    it('URL として解釈できない入力は TypeError を投げる(ConfigError にはしない)', () => {
      expect(() => canonicalizeUrl('これは URL ではありません')).toThrow(TypeError);
      expect(() => canonicalizeUrl('/relative/only')).toThrow(TypeError);
    });
  });

  describe('規則2: http は https に寄せる', () => {
    it('http:// を https:// に正規化する', () => {
      expect(canonicalizeUrl('http://www.mhlw.go.jp/stf/a.html')).toBe('https://www.mhlw.go.jp/stf/a.html');
    });

    it('スキームの大文字表記を小文字にする', () => {
      expect(canonicalizeUrl('HTTPS://www.mhlw.go.jp/a')).toBe('https://www.mhlw.go.jp/a');
    });

    it('http と https は同じ正規化 URL になる(= 同一アイテムとして扱われる)', () => {
      expect(canonicalizeUrl('http://example.jp/news')).toBe(canonicalizeUrl('https://example.jp/news'));
    });
  });

  describe('規則3: ホスト名の小文字化・末尾ドット除去・既定ポート除去', () => {
    it('ホスト名を小文字にする', () => {
      expect(canonicalizeUrl('https://WWW.MHLW.GO.JP/a')).toBe('https://www.mhlw.go.jp/a');
    });

    it('ホスト名の末尾ドットを除去する', () => {
      expect(canonicalizeUrl('https://www.mhlw.go.jp./a')).toBe('https://www.mhlw.go.jp/a');
    });

    it('既定ポート 80 / 443 を除去する', () => {
      expect(canonicalizeUrl('http://example.jp:80/a')).toBe('https://example.jp/a');
      expect(canonicalizeUrl('https://example.jp:443/a')).toBe('https://example.jp/a');
      // http:80 と https:443 は https に寄せたあと同じ URL になる。
      expect(canonicalizeUrl('http://example.jp:80/a')).toBe(canonicalizeUrl('https://example.jp:443/a'));
    });

    it('既定でないポートは残す', () => {
      expect(canonicalizeUrl('https://example.jp:8443/a')).toBe('https://example.jp:8443/a');
    });
  });

  describe('規則4: 計測用クエリの除去と残りのキー昇順ソート', () => {
    it('utm_* を除去する', () => {
      expect(canonicalizeUrl('https://example.jp/a?utm_source=line&utm_medium=sns&utm_campaign=x')).toBe(
        'https://example.jp/a',
      );
    });

    it('fbclid / gclid / yclid / _ga / mc_cid / mc_eid を除去する', () => {
      expect(canonicalizeUrl('https://example.jp/a?fbclid=1&gclid=2&yclid=3&_ga=4&mc_cid=5&mc_eid=6')).toBe(
        'https://example.jp/a',
      );
    });

    it('計測用でないクエリは残し、キー昇順にソートする', () => {
      expect(canonicalizeUrl('https://example.jp/a?z=1&b=2&a=3')).toBe('https://example.jp/a?a=3&b=2&z=1');
    });

    it('除去と並べ替えを同時に行う', () => {
      expect(canonicalizeUrl('https://example.jp/a?utm_source=x&page=2&id=9&fbclid=z')).toBe(
        'https://example.jp/a?id=9&page=2',
      );
    });

    it('クエリの並び順だけが違う URL は同じ正規化結果になる', () => {
      expect(canonicalizeUrl('https://example.jp/a?b=2&a=1')).toBe(
        canonicalizeUrl('https://example.jp/a?a=1&b=2'),
      );
    });
  });

  describe('規則5: ハッシュ(#)の除去', () => {
    it('フラグメントを落とす', () => {
      expect(canonicalizeUrl('https://example.jp/a#section-2')).toBe('https://example.jp/a');
    });

    it('クエリとフラグメントが両方あってもクエリだけ残す', () => {
      expect(canonicalizeUrl('https://example.jp/a?b=2&a=1#top')).toBe('https://example.jp/a?a=1&b=2');
    });
  });

  describe('規則6: 末尾スラッシュ', () => {
    it("パスが '/' のみなら末尾スラッシュを残す", () => {
      expect(canonicalizeUrl('https://example.jp/')).toBe('https://example.jp/');
    });

    it("パスを省略した場合も '/' になる", () => {
      expect(canonicalizeUrl('https://example.jp')).toBe('https://example.jp/');
    });

    it("'/' 以外のパスは末尾スラッシュを除去する", () => {
      expect(canonicalizeUrl('https://example.jp/news/')).toBe('https://example.jp/news');
      expect(canonicalizeUrl('https://example.jp/a/b/c/')).toBe('https://example.jp/a/b/c');
    });

    it('末尾スラッシュの有無で同じ正規化結果になる', () => {
      expect(canonicalizeUrl('https://example.jp/news/')).toBe(canonicalizeUrl('https://example.jp/news'));
    });
  });

  describe('規則7: パス中の重複スラッシュの畳み込み', () => {
    it('パス途中の連続スラッシュを 1 つにする', () => {
      expect(canonicalizeUrl('https://example.jp/a//b///c')).toBe('https://example.jp/a/b/c');
    });

    it('重複スラッシュと末尾スラッシュが同時にあっても正しく畳む', () => {
      expect(canonicalizeUrl('https://example.jp//a///b//')).toBe('https://example.jp/a/b');
    });

    it('ホスト直後の重複スラッシュだけの場合はルートになる', () => {
      expect(canonicalizeUrl('https://example.jp//')).toBe('https://example.jp/');
    });
  });

  describe('規則の複合', () => {
    it('7 規則すべてが必要な URL を 1 回で正規化する', () => {
      expect(
        canonicalizeUrl('HTTP://WWW.Example.JP.:80//stf//news//?utm_source=x&b=2&a=1&fbclid=z#head'),
      ).toBe('https://www.example.jp/stf/news?a=1&b=2');
    });

    it('正規化は冪等である(2 回かけても変わらない)', () => {
      const once = canonicalizeUrl('HTTP://WWW.Example.JP.:80//stf//news//?utm_source=x&b=2&a=1#head');
      expect(canonicalizeUrl(once)).toBe(once);
    });
  });
});

describe('hostOf', () => {
  it('小文字のホスト名を返す', () => {
    expect(hostOf('https://WWW.MHLW.GO.JP/stf/a.html')).toBe('www.mhlw.go.jp');
  });

  it('ポートやパスを含まない', () => {
    expect(hostOf('https://example.jp:8443/a/b?c=1')).toBe('example.jp');
  });

  it('不正な URL では空文字を返す', () => {
    expect(hostOf('これは URL ではありません')).toBe('');
    expect(hostOf('')).toBe('');
    expect(hostOf('/relative/path')).toBe('');
  });
});

describe('isHttpUrl', () => {
  it('http / https のみ true', () => {
    expect(isHttpUrl('http://example.jp/a')).toBe(true);
    expect(isHttpUrl('https://example.jp/a')).toBe(true);
  });

  it('巡回対象にしてはいけないスキームは false', () => {
    expect(isHttpUrl('javascript:void(0)')).toBe(false);
    expect(isHttpUrl('mailto:ops@example.com')).toBe(false);
    expect(isHttpUrl('ftp://example.jp/a')).toBe(false);
    expect(isHttpUrl('tel:0312345678')).toBe(false);
  });

  it('URL として解釈できない文字列は false(例外にしない)', () => {
    expect(isHttpUrl('')).toBe(false);
    expect(isHttpUrl('#')).toBe(false);
    expect(isHttpUrl('/relative/path')).toBe(false);
  });
});

describe('resolveUrl', () => {
  it('相対パスを base で絶対化する', () => {
    expect(resolveUrl('newpage.html', 'https://www.mhlw.go.jp/stf/index.html')).toBe(
      'https://www.mhlw.go.jp/stf/newpage.html',
    );
    expect(resolveUrl('/content/001.pdf', 'https://www.mhlw.go.jp/stf/index.html')).toBe(
      'https://www.mhlw.go.jp/content/001.pdf',
    );
  });

  it('絶対 URL はそのまま返す', () => {
    expect(resolveUrl('https://www.cfa.go.jp/a', 'https://www.mhlw.go.jp/')).toBe('https://www.cfa.go.jp/a');
  });

  it('不正なら null を返す(例外を投げない)', () => {
    expect(resolveUrl('newpage.html', 'not-a-base')).toBeNull();
    expect(resolveUrl('http://[', 'https://www.mhlw.go.jp/')).toBeNull();
  });
});
