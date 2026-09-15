/**
 * deliver ジョブの結合テスト(詳細設計書 §6.3 / §9.2 / §12、要件定義書 FR-10 / FR-12 / FR-15)。
 *
 * 配信は「二度送らない」「送りっぱなしにしない」が全て。
 *  - 冪等(FR-12): 同一日・同一チャネルへ 2 通目を送らない。
 *  - 復帰可能: 失敗しても同じ retryKey で送り直せる(LINE 側で重複排除される)。
 *  - 見張り(§12): digest が無い日は常に異常として通知する。
 */

import { describe, expect, it } from 'vitest';

import { approveDigest, runDeliver } from '../src/pipeline/deliver.js';
import { LineApiError } from '../src/types.js';
import type { Delivery, Digest } from '../src/types.js';
import { addDays } from '../src/util/time.js';
import { DEFAULT_DATE_JST, DEFAULT_NOW, makeChannel, makeContext } from './helpers/fakes.js';
import type { MakeContextOptions, TestContext } from './helpers/fakes.js';

const DOCUMENT_ID = `welfare_${DEFAULT_DATE_JST}`;

const MESSAGE_TEXT = [
  '【本日の制度・法改正まとめ】9/13(日)',
  '就労支援、放課後デイ情報局',
  '',
  '■1. 【重要】報酬改定Q&A(第3報)の公表について',
  '　専門的支援実施加算の算定要件が明確化されました。',
  '　対象: 放課後等デイサービス',
  '　出典: https://www.mhlw.go.jp/stf/newpage_00001.html',
  '',
  '※本まとめはAIが公的情報・報道を要約したものです。報道は速報であり、実際の手続きは必ず出典元の公的情報をご確認ください。',
].join('\n');

function makeDigest(overrides: Partial<Digest> = {}): Digest {
  return {
    id: DOCUMENT_ID,
    channelId: 'welfare',
    date: DEFAULT_DATE_JST,
    entries: [
      {
        itemId: 'item-0001',
        headline: '報酬改定Q&A(第3報)の公表について',
        summary: '専門的支援実施加算の算定要件が明確化されました。',
        affected: '放課後等デイサービス',
        dateNote: null,
        sourceUrl: 'https://www.mhlw.go.jp/stf/newpage_00001.html',
        importance: 'high',
      },
    ],
    excluded: [],
    omittedCount: 0,
    isEmpty: false,
    coverage: { total: 4, succeeded: 4, lastCollectedAtJst: '06:05' },
    messageText: MESSAGE_TEXT,
    status: 'generated',
    model: 'claude-opus-5',
    prompt: '[fake digest]',
    rawResponse: '{"entries":[],"omittedCount":0}',
    usage: null,
    createdAt: '2026-09-12T22:00:00.000Z',
    updatedAt: '2026-09-12T22:00:00.000Z',
    expiresAt: addDays('2026-09-12T22:00:00.000Z', 90),
    ...overrides,
  };
}

function setup(digest: Digest | null = makeDigest(), options: MakeContextOptions = {}): TestContext {
  const ctx = makeContext(options);
  if (digest !== null) ctx.store.seed({ digests: [digest] });
  return ctx;
}

function deliveryOf(ctx: TestContext): Delivery {
  const found = ctx.store.dump().deliveries.find((d) => d.id === DOCUMENT_ID);
  if (found === undefined) throw new Error(`配信記録が見つかりません: ${DOCUMENT_ID}`);
  return found;
}

describe('runDeliver: 正常配信(FR-10)', () => {
  it('broadcast を 1 回だけ呼び、digest と delivery を配信済みにする', async () => {
    const ctx = setup();

    const run = await runDeliver(ctx);

    expect(ctx.line.calls).toHaveLength(1);
    expect(ctx.line.calls[0]?.token).toBe('test-token-welfare');
    expect(ctx.line.calls[0]?.text).toBe(MESSAGE_TEXT);

    const digest = ctx.store.dump().digests[0];
    expect(digest?.status).toBe('delivered');
    expect(digest?.updatedAt).toBe(DEFAULT_NOW);

    const delivery = deliveryOf(ctx);
    expect(delivery.status).toBe('sent');
    expect(delivery.digestId).toBe(DOCUMENT_ID);
    expect(delivery.lineRequestId).toBe('line-request-1');
    expect(delivery.attempts).toBe(1);
    expect(delivery.sentAt).toBe(DEFAULT_NOW);
    expect(delivery.error).toBeNull();
    expect(delivery.expiresAt).toBe(addDays(DEFAULT_NOW, 90));

    // retryKey は「送信する前に」永続化されている(記録漏れによる二重配信の防止)。
    const firstWrite = ctx.store.deliveryWrites[0];
    expect(firstWrite?.status).toBe('failed');
    expect(firstWrite?.retryKey).toBe(ctx.line.calls[0]?.retryKey);

    expect(run.counts.sent).toBe(1);
    expect(run.counts.skipped).toBe(0);
    expect(run.status).toBe('succeeded');
    expect(ctx.notifier.calls).toEqual([]);
  });

  it('2 回実行しても 2 回目は送信しない(FR-12 冪等)', async () => {
    const ctx = setup();

    await runDeliver(ctx);
    const second = await runDeliver(ctx);

    expect(ctx.line.calls).toHaveLength(1);
    expect(second.counts.sent).toBe(0);
    expect(second.counts.skipped).toBe(1);
    expect(second.status).toBe('succeeded');
    expect(ctx.store.dump().deliveries).toHaveLength(1);
    expect(deliveryOf(ctx).attempts).toBe(1);
  });

  it('digest.status の更新に失敗していても delivery が sent なら送らない', async () => {
    // LINE には届いたが digest の更新前に落ちた、という状態を再現する。
    const ctx = setup(makeDigest({ status: 'generated' }));
    ctx.store.seed({
      deliveries: [
        {
          id: DOCUMENT_ID,
          channelId: 'welfare',
          date: DEFAULT_DATE_JST,
          digestId: DOCUMENT_ID,
          lineRequestId: 'line-request-0',
          retryKey: 'retry-key-0',
          status: 'sent',
          attempts: 1,
          sentAt: '2026-09-12T22:20:00.000Z',
          error: null,
          updatedAt: '2026-09-12T22:20:00.000Z',
          expiresAt: addDays('2026-09-12T22:20:00.000Z', 90),
        },
      ],
    });

    const run = await runDeliver(ctx);

    expect(ctx.line.calls).toHaveLength(0);
    expect(run.counts.skipped).toBe(1);
  });
});

describe('runDeliver: 失敗と再送(詳細設計書 §9.2)', () => {
  it('失敗しても digest は generated のまま残り、再実行は同じ retryKey で送る', async () => {
    const ctx = setup();
    ctx.line.setFailure(new LineApiError(500, 'LINE API がエラーを返しました'));

    const failed = await runDeliver(ctx);

    expect(failed.status).toBe('failed');
    expect(failed.counts.sent).toBe(0);
    expect(failed.errors.some((e) => e.includes('welfare'))).toBe(true);
    // 翌日の手動再配信ができるよう、digest の状態は戻さない。
    expect(ctx.store.dump().digests[0]?.status).toBe('generated');

    const afterFailure = deliveryOf(ctx);
    expect(afterFailure.status).toBe('failed');
    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.sentAt).toBeNull();
    expect(afterFailure.error).toContain('LINE API');

    const alerts = ctx.notifier.withTitle('LINE 配信に失敗しました');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.level).toBe('error');

    // 復旧後の再実行。
    ctx.line.setFailure(null);
    const retried = await runDeliver(ctx);

    expect(ctx.line.calls).toHaveLength(2);
    expect(ctx.line.calls[1]?.retryKey).toBe(ctx.line.calls[0]?.retryKey);
    expect(retried.counts.sent).toBe(1);
    const afterRetry = deliveryOf(ctx);
    expect(afterRetry.status).toBe('sent');
    expect(afterRetry.attempts).toBe(2);
    expect(afterRetry.retryKey).toBe(ctx.line.calls[0]?.retryKey);
    expect(ctx.store.dump().digests[0]?.status).toBe('delivered');
  });
});

describe('runDeliver: 承認モード(FR-15)', () => {
  it('generated のままでは配信せず、承認後に配信する', async () => {
    const ctx = setup(makeDigest(), { channels: [makeChannel({ requireApproval: true })] });

    const pending = await runDeliver(ctx);

    expect(ctx.line.calls).toHaveLength(0);
    expect(pending.counts.skipped).toBe(1);
    expect(pending.status).toBe('succeeded');
    const notices = ctx.notifier.withTitle('配信の承認待ちです');
    expect(notices).toHaveLength(1);
    expect(notices[0]?.level).toBe('info');

    const approved = await approveDigest(ctx, 'welfare', DEFAULT_DATE_JST);
    expect(approved.status).toBe('approved');
    expect(ctx.store.dump().digests[0]?.status).toBe('approved');

    const delivered = await runDeliver(ctx);

    expect(ctx.line.calls).toHaveLength(1);
    expect(delivered.counts.sent).toBe(1);
    expect(ctx.store.dump().digests[0]?.status).toBe('delivered');
  });
});

describe('runDeliver: ドライラン(FR-14)', () => {
  it('送信も記録もしない', async () => {
    const ctx = setup();

    const run = await runDeliver(ctx, { dryRun: true });

    expect(ctx.line.calls).toHaveLength(0);
    expect(ctx.store.dump().deliveries).toEqual([]);
    expect(ctx.store.deliveryWrites).toEqual([]);
    expect(ctx.store.dump().digests[0]?.status).toBe('generated');
    expect(run.counts.sent).toBe(0);
    expect(run.counts.skipped).toBe(1);
  });
});

describe('runDeliver: 見張りアラート(詳細設計書 §12)', () => {
  it('ダイジェストが無い日は error 通知を出す(0 件の日も digest は作られる設計のため)', async () => {
    const ctx = setup(null);

    const run = await runDeliver(ctx);

    expect(ctx.line.calls).toHaveLength(0);
    const alerts = ctx.notifier.withTitle('ダイジェストが見つかりません');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.level).toBe('error');
    expect(alerts[0]?.lines.some((line) => line.includes(DEFAULT_DATE_JST))).toBe(true);

    expect(run.counts.skipped).toBe(1);
    expect(run.errors).toHaveLength(1);
    expect(run.status).toBe('failed');
    expect(ctx.logger.find('error', 'ダイジェストが見つかりません')).toHaveLength(1);
  });

  it('生成に失敗した digest(status=failed)は配信せず通知する', async () => {
    const ctx = setup(makeDigest({ status: 'failed', messageText: '', entries: [] }));

    const run = await runDeliver(ctx);

    expect(ctx.line.calls).toHaveLength(0);
    expect(run.counts.skipped).toBe(1);
    expect(ctx.notifier.withTitle('生成に失敗したダイジェストがあります')).toHaveLength(1);
  });
});

describe('runDeliver: 実行記録(NFR-06)', () => {
  it('Run を開始時(running)と終了時の 2 回書き込む', async () => {
    const ctx = setup();

    const run = await runDeliver(ctx);

    expect(ctx.store.runWrites).toHaveLength(2);
    const [started, finished] = ctx.store.runWrites;
    expect(started?.id).toBe(run.id);
    expect(started?.job).toBe('deliver');
    expect(started?.status).toBe('running');
    expect(started?.finishedAt).toBeNull();
    expect(finished?.id).toBe(run.id);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.finishedAt).toBe(DEFAULT_NOW);
    expect(finished?.date).toBe(DEFAULT_DATE_JST);
    expect(ctx.store.dump().runs).toHaveLength(1);
  });
});
