/**
 * src/util/time.ts の単体テスト。
 *
 * 最重要の観点は「実行環境の TZ に依存しないこと」。
 * Cloud Run(UTC)・開発機・CI で結果が変われば配信日付がずれるという
 * 致命的な事故になるため、全ての公開関数を複数の TZ で実行して同じ結果を確認する。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  JST_OFFSET_MS,
  addDays,
  digestWindow,
  formatJstHeaderDate,
  isValidDateString,
  isoOf,
  jstWallClockToUtc,
  toJstDateString,
  toJstTimeString,
} from '../src/util/time.js';

/** UTC・西半球・JST の 3 つ。JST を含めるのは「たまたま合っていた」を防ぐため。 */
const TIME_ZONES = ['UTC', 'America/New_York', 'Asia/Tokyo'] as const;

let originalTz: string | undefined;

beforeEach(() => {
  originalTz = process.env.TZ;
});

afterEach(() => {
  if (originalTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTz;
  }
});

/** 指定 TZ に切り替えて検証本体を実行する。 */
function inTimeZone(tz: string, body: () => void): void {
  process.env.TZ = tz;
  body();
}

/** 全 TZ で同じ検証を回す。 */
function forEachTimeZone(body: (tz: string) => void): void {
  for (const tz of TIME_ZONES) {
    inTimeZone(tz, () => body(tz));
  }
}

describe('テスト前提: process.env.TZ の切り替えが実際に効いている', () => {
  it('ローカル時刻のゲッタは TZ で変わる(= TZ 非依存テストが空振りしていない)', () => {
    const instant = new Date('2026-09-12T00:00:00.000Z');
    let utcHours = -1;
    let jstHours = -1;
    inTimeZone('UTC', () => {
      utcHours = new Date(instant.getTime()).getHours();
    });
    inTimeZone('Asia/Tokyo', () => {
      jstHours = new Date(instant.getTime()).getHours();
    });
    expect(utcHours).toBe(0);
    expect(jstHours).toBe(9);
  });
});

describe('JST_OFFSET_MS', () => {
  it('9 時間のミリ秒である', () => {
    expect(JST_OFFSET_MS).toBe(9 * 60 * 60 * 1000);
  });
});

describe('isoOf', () => {
  it('どの TZ でも ISO8601 UTC 文字列を返す', () => {
    forEachTimeZone(() => {
      expect(isoOf(new Date(Date.UTC(2026, 8, 12, 3, 4, 5, 678)))).toBe('2026-09-12T03:04:05.678Z');
    });
  });
});

describe('toJstDateString', () => {
  it('JST の日付境界の直前(UTC 14:59:59)は前日のまま', () => {
    forEachTimeZone((tz) => {
      expect(toJstDateString(new Date('2026-09-11T14:59:59.999Z')), tz).toBe('2026-09-11');
    });
  });

  it('JST の日付境界の直後(UTC 15:00:00)は翌日になる', () => {
    forEachTimeZone((tz) => {
      expect(toJstDateString(new Date('2026-09-11T15:00:00.000Z')), tz).toBe('2026-09-12');
    });
  });

  it('月またぎ・年またぎの境界も JST 基準で判定する', () => {
    forEachTimeZone(() => {
      expect(toJstDateString(new Date('2026-08-31T14:59:59.999Z'))).toBe('2026-08-31');
      expect(toJstDateString(new Date('2026-08-31T15:00:00.000Z'))).toBe('2026-09-01');
      expect(toJstDateString(new Date('2025-12-31T14:59:59.999Z'))).toBe('2025-12-31');
      expect(toJstDateString(new Date('2025-12-31T15:00:00.000Z'))).toBe('2026-01-01');
    });
  });
});

describe('toJstTimeString', () => {
  it('JST 00:00 の直前と直後を正しく表す', () => {
    forEachTimeZone(() => {
      expect(toJstTimeString(new Date('2026-09-11T14:59:59.999Z'))).toBe('23:59');
      expect(toJstTimeString(new Date('2026-09-11T15:00:00.000Z'))).toBe('00:00');
    });
  });

  it('配信時刻(JST 07:30)を 2 桁ゼロ埋めで返す', () => {
    forEachTimeZone(() => {
      // JST 07:30 = UTC 前日 22:30
      expect(toJstTimeString(new Date('2026-09-11T22:30:00.000Z'))).toBe('07:30');
    });
  });
});

describe('jstWallClockToUtc', () => {
  it('JST の壁時計を UTC の瞬間へ変換する(JST 07:00 = UTC 前日 22:00)', () => {
    forEachTimeZone(() => {
      expect(jstWallClockToUtc('2026-09-12', '07:00').toISOString()).toBe('2026-09-11T22:00:00.000Z');
      expect(jstWallClockToUtc('2026-09-12', '00:00').toISOString()).toBe('2026-09-11T15:00:00.000Z');
      expect(jstWallClockToUtc('2026-09-12', '23:59').toISOString()).toBe('2026-09-12T14:59:00.000Z');
    });
  });

  it('toJstDateString / toJstTimeString と往復で一致する', () => {
    forEachTimeZone(() => {
      const d = jstWallClockToUtc('2026-01-01', '07:30');
      expect(toJstDateString(d)).toBe('2026-01-01');
      expect(toJstTimeString(d)).toBe('07:30');
    });
  });

  it('形式違い・実在しない日時は TypeError', () => {
    forEachTimeZone(() => {
      expect(() => jstWallClockToUtc('2026/09/12', '07:00')).toThrow(TypeError);
      expect(() => jstWallClockToUtc('2026-09-12', '0700')).toThrow(TypeError);
      expect(() => jstWallClockToUtc('2026-13-01', '07:00')).toThrow(TypeError);
      expect(() => jstWallClockToUtc('2026-09-12', '25:00')).toThrow(TypeError);
    });
  });
});

describe('digestWindow', () => {
  /**
   * モジュール契約 §src/util/time.ts:
   *   to   = jstWallClockToUtc(dateJst, cutoffHhmm)
   *   from = その 24 時間前
   * 詳細設計書 §6.2 の「detectedAt in [前日 07:00, 当日 07:00) JST」と一致する。
   * 2026-09-12 の 07:00 JST = 2026-09-11T22:00Z なので、
   * ウィンドウは [2026-09-10T22:00Z, 2026-09-11T22:00Z)(= 前日 07:00 JST 〜 当日 07:00 JST)。
   */
  it('契約どおり to = 当日 cutoff、from = その 24 時間前 になる', () => {
    forEachTimeZone(() => {
      expect(digestWindow('2026-09-12', '07:00')).toEqual({
        from: '2026-09-10T22:00:00.000Z',
        to: '2026-09-11T22:00:00.000Z',
      });
    });
  });

  it('to は jstWallClockToUtc(dateJst, cutoff) と一致する', () => {
    forEachTimeZone(() => {
      const { to } = digestWindow('2026-09-12', '07:00');
      expect(to).toBe(jstWallClockToUtc('2026-09-12', '07:00').toISOString());
    });
  });

  it('from と to の差はちょうど 24 時間', () => {
    forEachTimeZone(() => {
      const { from, to } = digestWindow('2026-03-01', '07:00');
      expect(new Date(to).getTime() - new Date(from).getTime()).toBe(24 * 60 * 60 * 1000);
    });
  });

  it('JST の日付境界をまたぐ日(月初)でも 24 時間ウィンドウを保つ', () => {
    forEachTimeZone(() => {
      expect(digestWindow('2026-01-01', '07:00')).toEqual({
        from: '2025-12-30T22:00:00.000Z',
        to: '2025-12-31T22:00:00.000Z',
      });
    });
  });
});

describe('formatJstHeaderDate', () => {
  it('曜日が正しい(連続する 7 日で全曜日を網羅する)', () => {
    forEachTimeZone(() => {
      // 2026-09-12 は土曜日。
      expect(formatJstHeaderDate('2026-09-12')).toBe('9/12(土)');
      expect(formatJstHeaderDate('2026-09-13')).toBe('9/13(日)');
      expect(formatJstHeaderDate('2026-09-14')).toBe('9/14(月)');
      expect(formatJstHeaderDate('2026-09-15')).toBe('9/15(火)');
      expect(formatJstHeaderDate('2026-09-16')).toBe('9/16(水)');
      expect(formatJstHeaderDate('2026-09-17')).toBe('9/17(木)');
      expect(formatJstHeaderDate('2026-09-18')).toBe('9/18(金)');
    });
  });

  it('年またぎ・うるう日でも曜日が正しい', () => {
    forEachTimeZone(() => {
      expect(formatJstHeaderDate('2026-01-01')).toBe('1/1(木)');
      expect(formatJstHeaderDate('2024-02-29')).toBe('2/29(木)');
      expect(formatJstHeaderDate('2026-12-31')).toBe('12/31(木)');
    });
  });

  it('月日はゼロ埋めしない', () => {
    forEachTimeZone(() => {
      expect(formatJstHeaderDate('2026-03-05')).toBe('3/5(木)');
    });
  });

  it('形式違いは TypeError', () => {
    expect(() => formatJstHeaderDate('2026/09/12')).toThrow(TypeError);
  });
});

describe('addDays', () => {
  it('ISO 文字列に日数を加算する', () => {
    forEachTimeZone(() => {
      expect(addDays('2026-09-12T00:00:00.000Z', 1)).toBe('2026-09-13T00:00:00.000Z');
      expect(addDays('2026-09-12T22:30:00.000Z', 90)).toBe('2026-12-11T22:30:00.000Z');
    });
  });

  it('負数で減算する', () => {
    forEachTimeZone(() => {
      expect(addDays('2026-09-12T00:00:00.000Z', -1)).toBe('2026-09-11T00:00:00.000Z');
      expect(addDays('2026-01-01T00:00:00.000Z', -1)).toBe('2025-12-31T00:00:00.000Z');
    });
  });

  it('0 日なら同じ瞬間(ISO 正規形)を返す', () => {
    forEachTimeZone(() => {
      expect(addDays('2026-09-12T01:02:03.004Z', 0)).toBe('2026-09-12T01:02:03.004Z');
    });
  });

  it('不正な ISO 文字列は TypeError', () => {
    expect(() => addDays('まったく日付ではない', 1)).toThrow(TypeError);
  });
});

describe('isValidDateString', () => {
  it('実在する日付は true', () => {
    forEachTimeZone(() => {
      expect(isValidDateString('2026-09-12')).toBe(true);
      expect(isValidDateString('2026-02-28')).toBe(true);
      expect(isValidDateString('2024-02-29')).toBe(true);
      expect(isValidDateString('2026-12-31')).toBe(true);
    });
  });

  it('実在しない日付は false', () => {
    forEachTimeZone(() => {
      expect(isValidDateString('2026-02-30')).toBe(false);
      expect(isValidDateString('2026-02-29')).toBe(false);
      expect(isValidDateString('2026-04-31')).toBe(false);
      expect(isValidDateString('2026-13-01')).toBe(false);
      expect(isValidDateString('2026-00-10')).toBe(false);
      expect(isValidDateString('2026-01-00')).toBe(false);
    });
  });

  it("'YYYY-MM-DD' 形式でないものは false", () => {
    forEachTimeZone(() => {
      expect(isValidDateString('2026-9-1')).toBe(false);
      expect(isValidDateString('2026/09/12')).toBe(false);
      expect(isValidDateString('20260912')).toBe(false);
      expect(isValidDateString('2026-09-12T00:00:00Z')).toBe(false);
      expect(isValidDateString('')).toBe(false);
    });
  });
});
