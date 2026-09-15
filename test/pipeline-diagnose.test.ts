/**
 * diagnose-sources の解析部の検証。
 *
 * 実運用で起きた失敗(Cloud Shell での初回 verify-sources)を再現している:
 * ページには到達できる(HTTP 200)のに itemSelector が当たらず候補 0 件、という
 * 「黙って何も拾わない」状態を検出し、直すべきセレクタを提示できること。
 */

import { describe, expect, it } from 'vitest';

import { analyzeListingHtml } from '../src/pipeline/diagnose.js';
import { makeSource } from './helpers/fakes.js';

const BASE = 'https://www.example.go.jp/stf/houdou/index.html';

/** 官公庁の一覧ページによくある構造。本文領域に #contents は無い。 */
const LISTING_HTML = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<link rel="alternate" type="application/rss+xml" href="/stf/news.rdf">
</head><body>
<div id="wrapper">
  <nav class="globalNav"><a href="/">ホーム</a><a href="/about/">案内</a></nav>
  <div id="main">
    <div class="m-listNews">
      <ul>
        <li><span class="date">令和8年9月14日</span><a href="/stf/houdou/a1.html">障害福祉サービス等報酬改定について</a></li>
        <li><span class="date">令和8年9月12日</span><a href="/stf/houdou/a2.html">放課後等デイサービスの基準改正</a></li>
        <li><span class="date">令和8年9月10日</span><a href="/stf/houdou/a3.html">就労継続支援A型の留意事項</a></li>
        <li><span class="date">令和8年9月8日</span><a href="/stf/houdou/a4.html">人材開発支援助成金の改正</a></li>
      </ul>
    </div>
    <div class="m-banner"><a href="/ad/x.html">広告1</a><a href="/ad/y.html">広告2</a><a href="/ad/z.html">広告3</a></div>
  </div>
</div></body></html>`;

function htmlSource(itemSelector: string, include: string[] = ['/stf/houdou/']) {
  return makeSource({
    id: 'test_src',
    type: 'html',
    url: BASE,
    html: {
      itemSelector,
      titleFrom: 'text',
      hrefFrom: 'href',
      dateSelector: null,
      includeUrlPatterns: include,
      excludeUrlPatterns: [],
    },
  });
}

describe('analyzeListingHtml', () => {
  it('当たっていない itemSelector を 0 件として報告する', () => {
    const r = analyzeListingHtml(LISTING_HTML, htmlSource('#contents a'), BASE);
    expect(r.currentLinks).toBe(0);
  });

  it('当たっている itemSelector の件数を数える', () => {
    const r = analyzeListingHtml(LISTING_HTML, htmlSource('.m-listNews a'), BASE);
    expect(r.currentLinks).toBe(4);
  });

  it('0 件のときに、実際にリンクが集まっている領域を候補として出す', () => {
    const r = analyzeListingHtml(LISTING_HTML, htmlSource('#contents a'), BASE);
    const selectors = r.candidates.map((c) => c.selector);
    expect(selectors).toContain('div.m-listNews a');
    // include で絞られるため広告は候補にならない。
    expect(selectors).not.toContain('div.m-banner a');
  });

  it('候補には実例を添える(妥当性を人が判断できるようにするため)', () => {
    const r = analyzeListingHtml(LISTING_HTML, htmlSource('#contents a'), BASE);
    const best = r.candidates.find((c) => c.selector === 'div.m-listNews a');
    expect(best?.links).toBe(4);
    expect(best?.samples[0]?.text).toContain('障害福祉サービス等報酬改定');
    expect(best?.samples[0]?.href).toBe('https://www.example.go.jp/stf/houdou/a1.html');
  });

  it('相対リンクを最終 URL 基準で絶対化する', () => {
    const r = analyzeListingHtml(LISTING_HTML, htmlSource('.m-listNews a'), BASE);
    const best = r.candidates.find((c) => c.selector === 'div.m-listNews a');
    for (const s of best?.samples ?? []) {
      expect(s.href.startsWith('https://www.example.go.jp/')).toBe(true);
    }
  });

  it('ページが公開しているフィードを拾う(ボット拒否サイトの代替手段になる)', () => {
    const r = analyzeListingHtml(LISTING_HTML, htmlSource('#contents a'), BASE);
    expect(r.feeds).toEqual(['https://www.example.go.jp/stf/news.rdf']);
  });

  it('絞り込みが無ければ広告領域も候補に出す(判断は人に委ねる)', () => {
    const r = analyzeListingHtml(LISTING_HTML, htmlSource('#contents a', []), BASE);
    expect(r.candidates.map((c) => c.selector)).toContain('div.m-banner a');
  });

  it('不正なセレクタは 0 件ではなく判定不能(null)にする', () => {
    const r = analyzeListingHtml(LISTING_HTML, htmlSource('>>> broken'), BASE);
    expect(r.currentLinks).toBeNull();
  });
});
