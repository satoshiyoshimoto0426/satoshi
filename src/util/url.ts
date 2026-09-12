/**
 * URL の正規化と判定。
 *
 * なぜ正規化が要るか(詳細設計書 §5.1): items の ID は正規化 URL の SHA-256 である。
 * 同じ記事が `http://` と `https://`、`?utm_source=...` 付き、末尾スラッシュ有無で
 * 届いても「同じ 1 件」として扱えなければ、毎朝同じ情報を重複配信してしまう。
 */

/** 計測用パラメータ。本文の同一性に影響しないので除去する。 */
const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'yclid', '_ga', 'mc_cid', 'mc_eid']);
const TRACKING_PREFIX = 'utm_';

/** 既定ポート。スキームに関わらずこの 2 つは表記から落とす(契約 §src/util/url.ts 規則3)。 */
const DEFAULT_PORTS = new Set(['80', '443']);

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith(TRACKING_PREFIX) || TRACKING_PARAMS.has(k);
}

/**
 * URL を正規化する。規則は以下の順に適用する。
 *  1. base があれば絶対化(不正な URL は TypeError がそのまま伝播する)
 *  2. プロトコルを小文字化し、http: は https: に寄せる
 *  3. ホスト名を小文字化、末尾ドットを除去、既定ポート(80/443)を除去
 *  4. 計測用クエリ(utm_* / fbclid / gclid / yclid / _ga / mc_cid / mc_eid)を除去し、キー昇順にソート
 *  5. ハッシュ(#...)を除去
 *  6. パスが '/' のみなら末尾スラッシュを残し、それ以外は末尾スラッシュを除去
 *  7. パス中の重複スラッシュを 1 つに畳む
 *
 * @throws {TypeError} raw(と base)が URL として解釈できない場合。
 *   なぜ ConfigError にしないか: 呼び出し側(fetchers)が「この 1 件だけ捨てる」判断を
 *   するための素の失敗であり、設定不備とは限らないため。契約どおり TypeError のまま投げる。
 */
export function canonicalizeUrl(raw: string, base?: string): string {
  // 1. 絶対化
  const u = base ? new URL(raw, base) : new URL(raw);

  // 2. プロトコル(URL パーサが既に小文字化しているが、意図を明示するため再適用)
  let protocol = u.protocol.toLowerCase();
  if (protocol === 'http:') protocol = 'https:';

  if (protocol !== 'https:') {
    // http/https 以外(mailto: など)はホストやパスの概念が異なる。
    // 壊さないよう、ハッシュ除去だけ行って返す。
    u.hash = '';
    return u.toString();
  }

  // 3. ホストとポート
  const hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  const port = DEFAULT_PORTS.has(u.port) ? '' : u.port;

  // 4. クエリ
  const kept: { key: string; value: string }[] = [];
  for (const [key, value] of u.searchParams) {
    if (isTrackingParam(key)) continue;
    kept.push({ key, value });
  }
  // キーのみで比較する。Array#sort は安定なので同名キーの値の順序は保たれる。
  kept.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const search = new URLSearchParams(kept.map((p) => [p.key, p.value])).toString();

  // 5. ハッシュは捨てる(6・7 でパスを整える)
  let path = u.pathname;

  // 6. 末尾スラッシュ。'/' だけのときは残す
  if (path !== '/') path = path.replace(/\/+$/, '');

  // 7. 重複スラッシュを畳む
  path = path.replace(/\/{2,}/g, '/');
  if (path === '') path = '/';

  // 認証情報は落とさない(稀だが落とすと別 URL になってしまうため)
  const auth = u.username ? `${u.username}${u.password ? `:${u.password}` : ''}@` : '';
  const host = port ? `${hostname}:${port}` : hostname;
  return `${protocol}//${auth}${host}${path}${search ? `?${search}` : ''}`;
}

/** 小文字のホスト名。URL として解釈できなければ ''。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** http / https のみ true。javascript: や mailto: を巡回対象から外すために使う。 */
export function isHttpUrl(u: string): boolean {
  try {
    const protocol = new URL(u).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * 相対 URL を base で絶対化する。不正なら null。
 *
 * なぜ例外にしないか: HTML から拾った href には `#`、`javascript:void(0)`、
 * 空文字などが混ざる。1 件の壊れたリンクでソース全体の巡回を止めないため、
 * 呼び出し側が素直に読み飛ばせる null を返す。
 */
export function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
