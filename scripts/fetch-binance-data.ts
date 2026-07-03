/**
 * Binance公開APIから直接データを取得するスクリプト（OBS000021）
 *
 * 背景: これまで取引所APIはネットワークポリシーでブロックされている前提で
 * GitHub raw経由のコミュニティデータセットを使ってきた（OBS000014）。
 * 2026-07-04に再確認したところ、Binance spot klines / USDT-M先物 Funding Rate /
 * CoinGecko への直接アクセスが可能であることが判明した。認証不要の公開APIのみ使用する。
 *
 * 取得内容:
 *   - BTCUSDT / ETHUSDT 日足OHLCV（spot, 2017-08-17〜現在。GitHub由来データより
 *     連続的で欠落がない。特にETHはこれまでのGitHubデータに約9ヶ月の欠落があった）
 *   - BTCUSDT / ETHUSDT Funding Rate履歴（USDT-M無期限先物, 8時間おき,
 *     BTCは2019-09-19〜、ETHは2019-11-27〜現在）
 *
 * レート制限に配慮し、リクエスト間に短い待機を挟む。
 *
 * 実行例:
 *   node --experimental-strip-types scripts/fetch-binance-data.ts
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/** 日足klinesをページネーションしながら全期間取得する */
async function fetchDailyKlines(symbol: string, startTime: number): Promise<string[]> {
  const rows: string[] = ['date,open,high,low,close,volume_usd'];
  let cursor = startTime;
  const now = Date.now();
  while (cursor < now) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&startTime=${cursor}&limit=1000`;
    const data = await fetchJson(url) as unknown[][];
    if (data.length === 0) break;
    for (const k of data) {
      const openTime = k[0] as number;
      const date = new Date(openTime).toISOString().slice(0, 10);
      rows.push([date, k[1], k[2], k[3], k[4], k[5]].join(','));
    }
    const lastOpenTime = data[data.length - 1][0] as number;
    cursor = lastOpenTime + 24 * 60 * 60 * 1000;
    console.log(`  ${symbol} klines: ${rows.length - 1}件取得済み（最新 ${new Date(lastOpenTime).toISOString().slice(0, 10)}）`);
    if (data.length < 1000) break;
    await sleep(300);
  }
  return rows;
}

/** Funding RateをページネーションしながらSGetする（8時間おきのイベント単位） */
async function fetchFundingRateHistory(symbol: string, startTime: number): Promise<string[]> {
  const rows: string[] = ['datetime,funding_rate'];
  let cursor = startTime;
  const now = Date.now();
  while (cursor < now) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&limit=1000`;
    const data = await fetchJson(url) as { fundingTime: number; fundingRate: string }[];
    if (data.length === 0) break;
    for (const f of data) {
      rows.push([new Date(f.fundingTime).toISOString(), f.fundingRate].join(','));
    }
    const lastTime = data[data.length - 1].fundingTime;
    cursor = lastTime + 1;
    console.log(`  ${symbol} funding: ${rows.length - 1}件取得済み（最新 ${new Date(lastTime).toISOString().slice(0, 10)}）`);
    if (data.length < 1000) break;
    await sleep(300);
  }
  return rows;
}

async function main(): Promise<void> {
  const BTC_KLINE_START = Date.parse('2017-08-17T00:00:00Z');
  const ETH_KLINE_START = Date.parse('2017-08-17T00:00:00Z');
  const BTC_FUNDING_START = Date.parse('2019-09-19T00:00:00Z');
  const ETH_FUNDING_START = Date.parse('2019-11-27T00:00:00Z');

  console.log('=== BTCUSDT 日足klines取得 ===');
  const btcKlines = await fetchDailyKlines('BTCUSDT', BTC_KLINE_START);
  writeFileSync(join(DATA_DIR, 'btc-daily-binance-2017-2026.csv'), btcKlines.join('\n') + '\n');
  console.log(`保存: btc-daily-binance-2017-2026.csv (${btcKlines.length - 1}行)\n`);

  console.log('=== ETHUSDT 日足klines取得 ===');
  const ethKlines = await fetchDailyKlines('ETHUSDT', ETH_KLINE_START);
  writeFileSync(join(DATA_DIR, 'eth-daily-binance-2017-2026.csv'), ethKlines.join('\n') + '\n');
  console.log(`保存: eth-daily-binance-2017-2026.csv (${ethKlines.length - 1}行)\n`);

  console.log('=== BTCUSDT Funding Rate履歴取得 ===');
  const btcFunding = await fetchFundingRateHistory('BTCUSDT', BTC_FUNDING_START);
  writeFileSync(join(DATA_DIR, 'btc-funding-2019-2026.csv'), btcFunding.join('\n') + '\n');
  console.log(`保存: btc-funding-2019-2026.csv (${btcFunding.length - 1}行)\n`);

  console.log('=== ETHUSDT Funding Rate履歴取得 ===');
  const ethFunding = await fetchFundingRateHistory('ETHUSDT', ETH_FUNDING_START);
  writeFileSync(join(DATA_DIR, 'eth-funding-2019-2026.csv'), ethFunding.join('\n') + '\n');
  console.log(`保存: eth-funding-2019-2026.csv (${ethFunding.length - 1}行)\n`);

  console.log('=== 完了 ===');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
