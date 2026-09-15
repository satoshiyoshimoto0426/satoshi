/**
 * 礼節を守る HTTP クライアント。
 *
 * 満たす要件:
 *  - NFR-07: robots.txt を尊重し、同一ホストへのアクセスは 2 秒以上空ける。
 *    User-Agent に連絡先を明記する。
 *  - 詳細設計書 §6.1: 条件付き GET(ETag / If-Modified-Since)、タイムアウト、
 *    429 / 5xx / ネットワークエラーのリトライ。
 *  - 日本の官公庁・自治体サイトは今なお Shift_JIS / EUC-JP / ISO-2022-JP が
 *    現役なので、文字コードを判定して UTF-8 に正規化する。
 *
 * 直列化の仕組み: 「ホスト名 → { 直前リクエストの完了時刻, 待ち行列の Promise チェーン }」
 * を保持し、同一ホストへのリクエストはチェーンに積んで 1 本ずつ実行する。
 * 完了時刻から `hostDelayMs` 経過するまで次のリクエストを開始しない。
 * ホストが違えばチェーンも別なので、並列度は呼び出し側(p-limit)が決められる。
 */

import iconv from 'iconv-lite';
import robotsParser from 'robots-parser';

import type { HttpClient, HttpGetOptions, HttpResponse, Logger, RuntimeConfig } from '../types.js';
import { HttpError, RobotsDisallowedError } from '../types.js';
import { systemClock } from './clock.js';
import { sleep as defaultSleep, withRetry } from './retry.js';
import { hostOf } from './url.js';

export interface HttpClientDeps {
  /** テストで差し替える fetch。既定はグローバル fetch。 */
  fetchImpl?: typeof fetch;
  /** テストで差し替える待機関数。実時間を進めずにレート制限を検証するため。 */
  sleep?: (ms: number) => Promise<void>;
}

/** robots.txt のキャッシュ有効期間。1 時間(契約)。 */
const ROBOTS_TTL_MS = 60 * 60 * 1000;

/** 日本語サイトを優先して受け取る。 */
const ACCEPT_LANGUAGE = 'ja,en;q=0.8';

const DEFAULT_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/** 文字コード判定のために先頭から覗くバイト数。 */
const CHARSET_SNIFF_BYTES = 2048;

/** robots-parser の戻り値のうち本モジュールが使う部分。 */
interface RobotsChecker {
  isAllowed(url: string, ua?: string): boolean | undefined;
}

interface HostQueue {
  /** 直前までの処理をつないだ Promise チェーン。ここに次のタスクを積む。 */
  tail: Promise<void>;
  /** 直前のリクエストが完了した時刻(epoch ms)。0 は「まだ 1 回も出していない」。 */
  lastCompletedAt: number;
}

interface RobotsCacheEntry {
  fetchedAt: number;
  /** null は「robots.txt が無い / 取得失敗」= 全面許可。 */
  value: Promise<RobotsChecker | null>;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** Content-Type からバイナリかどうかを判定する。判定不能(空)ならテキスト扱い。 */
function isBinaryContentType(contentType: string): boolean {
  const mime = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (mime === '') return false;
  if (mime.startsWith('text/')) return false;
  if (mime.endsWith('+xml') || mime.endsWith('+json')) return false;
  return !/^application\/(xml|json|rss\+xml|atom\+xml|rdf\+xml|x?html|javascript|x-javascript)$/.test(mime);
}

/** charset ラベルを iconv-lite が解釈できる名前に寄せる。 */
function normalizeCharsetLabel(label: string): string {
  const key = label
    .trim()
    .toLowerCase()
    .replace(/^["']|["']$/g, '')
    .replace(/[^a-z0-9]/g, '');
  switch (key) {
    case 'shiftjis':
    case 'sjis':
    case 'xsjis':
    case 'mskanji':
    case 'windows31j':
    case 'cp932':
    case 'csshiftjis':
      return 'Shift_JIS';
    case 'eucjp':
    case 'xeucjp':
    case 'cseucpkdfmtjapanese':
      return 'EUC-JP';
    case 'iso2022jp':
    case 'csiso2022jp':
      return 'ISO-2022-JP';
    case 'utf8':
      return 'utf-8';
    default:
      return label.trim().replace(/^["']|["']$/g, '');
  }
}

/**
 * 文字コードを判定する。優先順位は
 *   1. Content-Type の charset
 *   2. HTML の <meta charset> / <meta http-equiv="Content-Type">(先頭 2KB)
 *   3. XML 宣言の encoding=
 * いずれも取れなければ null(= UTF-8 として扱う)。
 */
function detectCharset(contentType: string, head: string): string | null {
  const fromHeader = /charset\s*=\s*["']?([\w.:+-]+)/i.exec(contentType);
  if (fromHeader?.[1]) return fromHeader[1];

  const fromMeta = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:+-]+)/i.exec(head);
  if (fromMeta?.[1]) return fromMeta[1];

  const fromXml = /<\?xml[^>]*\bencoding\s*=\s*["']([\w.:+-]+)["']/i.exec(head);
  if (fromXml?.[1]) return fromXml[1];

  return null;
}

/**
 * Node 標準の TextDecoder で復号する。扱えないラベルなら null。
 * iconv-lite が対応していないエンコーディング(ISO-2022-JP)の受け皿。
 */
function decodeWithTextDecoder(buf: Buffer, label: string): string | null {
  try {
    // fatal: false なので不正バイトは U+FFFD になる。1 文字の化けで巡回を止めない。
    return new TextDecoder(label.toLowerCase(), { fatal: false }).decode(buf);
  } catch {
    // 未知のラベル(RangeError)。呼び出し元が UTF-8 にフォールバックする。
    return null;
  }
}

/** バイト列を UTF-8 文字列にする。BOM は iconv-lite が除去する。 */
function decodeText(buf: Buffer, contentType: string): string {
  // 先頭だけ latin1 で覗く。ASCII のタグ部分はどの日本語エンコーディングでもそのまま読める。
  const head = buf.subarray(0, CHARSET_SNIFF_BYTES).toString('latin1');
  const detected = detectCharset(contentType, head);
  if (detected) {
    const normalized = normalizeCharsetLabel(detected);
    if (normalized.toLowerCase() !== 'utf-8') {
      if (iconv.encodingExists(normalized)) {
        return iconv.decode(buf, normalized);
      }
      // iconv-lite 0.7.x は ISO-2022-JP(エスケープシーケンス方式)を実装していない。
      // Node 22 の TextDecoder は full-ICU 同梱で iso-2022-jp を扱えるので、そちらへ退避する。
      const decoded = decodeWithTextDecoder(buf, normalized);
      if (decoded !== null) return decoded;
    }
  }
  // 判定不能・未知のエンコーディングは UTF-8 とみなす(契約)。
  return iconv.decode(buf, 'utf-8');
}

/** 再試行してよい失敗か。4xx(429 以外)は何度やっても同じなので即諦める。 */
function isRetryableError(e: unknown): boolean {
  if (e instanceof RobotsDisallowedError) return false;
  if (e instanceof HttpError) return e.status === 429 || e.status >= 500;
  // タイムアウト(TimeoutError)や接続断(TypeError)などネットワーク層の例外は再試行する。
  return true;
}

/**
 * 内部ネットワーク宛のホスト名か。
 *
 * 巡回先の候補リンクは外部サイトの HTML から取る。悪意のある/壊れたページが
 * `http://169.254.169.254/...` や `http://10.0.0.1/` を張っていると、本文抽出が
 * そこへ GET してしまう(SSRF)。クラウドのメタデータサーバや内部ネットワークの
 * 探索に使われうるため、アプリ側でも塞ぐ。インフラの egress 制限(詳細設計書 §11)と
 * 二重のガードにする。
 *
 * 名前解決までは行わない(DNS リバインディングは egress ポリシー側の担当)。
 * ここで止めるのは「URL に直接書かれた内部アドレス」。
 */
export function isInternalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    return true;
  }
  // IPv6 は角括弧付きで渡ってくる。ループバックとユニークローカルを塞ぐ。
  if (h.startsWith('[')) {
    const v6 = h.slice(1, -1);
    return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m === null) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127 || a === 0 || a === 10) return true; // ループバック / 未指定 / プライベート
  if (a === 169 && b === 254) return true; // リンクローカル(クラウドのメタデータサーバ)
  if (a === 172 && b >= 16 && b <= 31) return true; // プライベート
  if (a === 192 && b === 168) return true; // プライベート
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

export function createHttpClient(runtime: RuntimeConfig, logger: Logger, deps?: HttpClientDeps): HttpClient {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const sleepFn = deps?.sleep ?? defaultSleep;

  const queues = new Map<string, HostQueue>();
  const robotsCache = new Map<string, RobotsCacheEntry>();

  /** 実時刻。直接 Date.now() を呼ばず Clock 経由にする(絶対ルール5)。 */
  const nowMs = (): number => systemClock.now().getTime();

  /**
   * 同一ホストのタスクを 1 本の待ち行列に積み、直前の完了から hostDelayMs 空けて実行する。
   */
  function runOnHost<T>(host: string, task: () => Promise<T>): Promise<T> {
    let queue = queues.get(host);
    if (!queue) {
      queue = { tail: Promise.resolve(), lastCompletedAt: 0 };
      queues.set(host, queue);
    }
    const q = queue;

    const run = q.tail.then(async () => {
      const waitMs = q.lastCompletedAt === 0 ? 0 : runtime.hostDelayMs - (nowMs() - q.lastCompletedAt);
      if (waitMs > 0) {
        logger.debug('同一ホストへの間隔を空けます', { host, waitMs });
        await sleepFn(waitMs);
      }
      try {
        return await task();
      } finally {
        // 「完了時刻」を基準にするので、遅いレスポンスの直後に畳み掛けることがない。
        q.lastCompletedAt = nowMs();
      }
    });

    // 1 件の失敗で後続を止めないよう、チェーンには結果を握った void 版をつなぐ。
    // 呼び出し側には run をそのまま返すので、例外は失われない。
    q.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function buildHeaders(options: HttpGetOptions): Record<string, string> {
    const headers: Record<string, string> = {
      // 連絡先入りの UA(NFR-07)。相手サイトの運用者が問い合わせられるようにする。
      'User-Agent': runtime.userAgent,
      'Accept-Language': ACCEPT_LANGUAGE,
      Accept: options.accept ?? DEFAULT_ACCEPT,
    };
    // 条件付き GET。変化が無ければ 304 が返り、本文転送も本文解析も省ける。
    if (options.etag) headers['If-None-Match'] = options.etag;
    if (options.lastModified) headers['If-Modified-Since'] = options.lastModified;
    return headers;
  }

  function doFetch(
    method: 'GET' | 'HEAD',
    target: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<Response> {
    return fetchImpl(target, {
      method,
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** 使わない本文を読み捨ててコネクションを解放する。 */
  async function drain(res: Response): Promise<void> {
    try {
      await res.arrayBuffer();
    } catch {
      // 破棄目的なので読み取り失敗は無視してよい(呼び出し元は status しか見ない)。
    }
  }

  function collectHeaders(res: Response): Record<string, string> {
    const out: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }

  /**
   * robots.txt を取得して解析する。ホスト単位で 1 時間キャッシュ。
   * 取得できない場合(404 / ネットワーク失敗)は null = 全面許可とする。
   */
  function getRobots(url: string, host: string): Promise<RobotsChecker | null> {
    const cached = robotsCache.get(host);
    if (cached && nowMs() - cached.fetchedAt < ROBOTS_TTL_MS) return cached.value;

    const robotsUrl = new URL('/robots.txt', url).toString();
    // 同一ホストへ同時に複数リクエストが来ても robots.txt の取得は 1 回で済むよう、
    // 結果ではなく「取得中の Promise」をキャッシュする。
    const value = (async (): Promise<RobotsChecker | null> => {
      try {
        // ここで robots チェックはしない(robots.txt 自身を取りに行くので無限再帰になる)。
        const res = await runOnHost(host, () =>
          doFetch('GET', robotsUrl, buildHeaders({ accept: 'text/plain,*/*;q=0.8' }), runtime.httpTimeoutMs),
        );
        if (res.status >= 200 && res.status < 300) {
          const body = await res.text();
          return robotsParser(robotsUrl, body) as RobotsChecker;
        }
        await drain(res);
        logger.debug('robots.txt を取得できませんでした(許可として扱います)', { host, status: res.status });
        return null;
      } catch (e) {
        // robots.txt が引けないことを理由に巡回全体を止めない(契約どおり「許可」扱い)。
        logger.debug('robots.txt の取得に失敗しました(許可として扱います)', { host, error: errorMessage(e) });
        return null;
      }
    })();

    robotsCache.set(host, { fetchedAt: nowMs(), value });
    return value;
  }

  async function ensureRobotsAllowed(url: string, host: string): Promise<void> {
    const robots = await getRobots(url, host);
    if (!robots) return;
    // isAllowed は判定不能なとき undefined を返す。その場合は許可とみなす。
    if (robots.isAllowed(url, runtime.userAgent) === false) {
      logger.warn('robots.txt により取得が許可されていません', { url, host });
      throw new RobotsDisallowedError(url);
    }
  }

  async function get(url: string, options: HttpGetOptions = {}): Promise<HttpResponse> {
    const host = hostOf(url);
    if (!host) throw new TypeError(`HttpClient.get: 不正な URL です: ${url}`);
    if (isInternalHost(host)) {
      // 外部サイトのリンク経由で内部ネットワークへ到達させない(SSRF 対策)。
      throw new HttpError(0, url, `内部ネットワーク宛の URL は取得しません: ${host}`);
    }

    if (!options.skipRobots) {
      await ensureRobotsAllowed(url, host);
    }

    const timeoutMs = options.timeoutMs ?? runtime.httpTimeoutMs;

    return withRetry(
      () =>
        runOnHost(host, async () => {
          const startedAt = nowMs();
          const res = await doFetch('GET', url, buildHeaders(options), timeoutMs);
          const durationMs = nowMs() - startedAt;
          const headers = collectHeaders(res);
          const finalUrl = res.url !== '' ? res.url : url;

          // 304 は「変化なし」という正常な答え。例外にせずそのまま返す。
          if (res.status === 304) {
            await drain(res);
            logger.debug('HTTP 応答', { url, status: 304, durationMs });
            return { status: 304, text: '', body: new Uint8Array(0), headers, finalUrl };
          }

          if (res.status >= 400) {
            await drain(res);
            throw new HttpError(res.status, url);
          }

          const arrayBuffer = await res.arrayBuffer();
          const buf = Buffer.from(arrayBuffer);
          const contentType = headers['content-type'] ?? '';
          // PDF などのバイナリは text を空にして body だけ埋める(契約)。
          const text = isBinaryContentType(contentType) ? '' : decodeText(buf, contentType);

          logger.debug('HTTP 応答', {
            url,
            status: res.status,
            durationMs,
            bytes: buf.byteLength,
            contentType,
          });

          return { status: res.status, text, body: new Uint8Array(arrayBuffer), headers, finalUrl };
        }),
      {
        retries: options.retries ?? 2,
        // 再試行の初期待機はホスト間隔と同じにしておく(相手に畳み掛けないため)。
        baseDelayMs: runtime.hostDelayMs,
        shouldRetry: isRetryableError,
        onRetry: (e, attempt, delayMs) => {
          logger.warn('HTTP 取得に失敗したため再試行します', {
            url,
            attempt,
            delayMs,
            error: errorMessage(e),
          });
        },
        sleep: sleepFn,
      },
    );
  }

  /**
   * 到達確認(品質ゲート Q2 / verify-sources)。
   * まず HEAD、HEAD を受け付けないサーバ(405 / 501 / 403)には GET で確認し直す。
   * 例外は投げず、結果を戻り値で返す(1 件の失敗で一覧処理を止めないため)。
   */
  async function checkReachable(
    url: string,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; status: number | null; error: string | null; robotsDisallowed?: boolean }> {
    const host = hostOf(url);
    if (!host) return { ok: false, status: null, error: 'URL を解釈できません' };
    if (isInternalHost(host)) {
      // 内部アドレスを出典として配信してはいけない(SSRF 対策 / Q2)。
      return { ok: false, status: null, error: `内部ネットワーク宛の URL です: ${host}` };
    }

    const timeout = timeoutMs ?? runtime.httpTimeoutMs;
    const headers = buildHeaders({});

    try {
      // 到達確認でも robots チェックは省略しない(契約)。
      await ensureRobotsAllowed(url, host);

      let res = await runOnHost(host, () => doFetch('HEAD', url, headers, timeout));
      await drain(res);

      if (res.status === 405 || res.status === 501 || res.status === 403) {
        // HEAD を実装していない / 誤って弾くサーバが官公庁サイトには実在する。
        res = await runOnHost(host, () => doFetch('GET', url, headers, timeout));
        await drain(res);
      }

      const ok = res.status >= 200 && res.status < 400;
      logger.debug('到達確認', { url, status: res.status, ok });
      return { ok, status: res.status, error: ok ? null : `HTTP ${res.status}` };
    } catch (e) {
      const message = errorMessage(e);
      logger.debug('到達確認に失敗しました', { url, error: message });
      if (e instanceof RobotsDisallowedError) {
        // 通信の失敗ではなく、相手の意思による拒否。呼び出し側が区別できるよう印を付ける。
        return { ok: false, status: null, error: message, robotsDisallowed: true };
      }
      return { ok: false, status: null, error: message };
    }
  }

  return { get, checkReachable };
}
