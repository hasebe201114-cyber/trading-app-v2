/**
 * ③LLM特徴量抽出 日次バッチ（OBS000014）
 *
 * 各営業日について「当日のBTCニュース上位N件＋価格コンテキスト」をLLMに渡し、
 * MarketContextOutput（eventImpactScore等）を抽出してJSONキャッシュに保存する。
 * キャッシュ済みの日付はスキップするため、中断しても再実行で続きから処理できる。
 *
 * 実行例:
 *   # 配線検証（APIキー不要。mockClientで全日付を即時処理）
 *   node --experimental-strip-types scripts/llm-feature-extraction.ts --mock
 *
 *   # 実LLM実行（ANTHROPIC_API_KEY が必要。まず--limitで小規模に試すこと）
 *   node --experimental-strip-types scripts/llm-feature-extraction.ts --limit 5
 *   node --experimental-strip-types scripts/llm-feature-extraction.ts
 *
 * オプション:
 *   --mock            実LLMの代わりにmockClient（キーワードマッチ）を使用
 *   --from YYYY-MM-DD 開始日（既定: 2021-01-01。ニュース高密度期間の開始）
 *   --to   YYYY-MM-DD 終了日（既定: 価格データの最終日）
 *   --limit N         未処理日のうち先頭N日だけ処理（実LLMの小規模動作確認用）
 *   --concurrency C   実LLMの同時リクエスト数（既定: 2）
 *
 * 出力: scripts/data/llm-features-daily.{mock|live}.json
 *   { "YYYY-MM-DD": MarketContextLogEntry, ... }
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadOhlcvFromDailyCsv } from './loadCsvData.ts';
import { loadNewsFromCsvGz, groupNewsByUtcDate, selectTopHeadlines } from './loadNewsData.ts';
import { analyzeMarketContext, getConfiguredModel } from '../src/llm-layer/client.ts';
import { mockAnalyzeMarketContext } from '../src/llm-layer/mockClient.ts';
import type { MarketContextInput, MarketContextLogEntry } from '../src/llm-layer/types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

// --- 引数パース ---
const args = process.argv.slice(2);
const hasFlag = (name: string): boolean => args.includes(name);
const getOption = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const useMock = hasFlag('--mock');
const fromDate = getOption('--from') ?? '2021-01-01';
const toDateOption = getOption('--to');
const limit = getOption('--limit') ? parseInt(getOption('--limit')!, 10) : Infinity;
const concurrency = getOption('--concurrency') ? parseInt(getOption('--concurrency')!, 10) : 2;

const cachePath = join(DATA_DIR, `llm-features-daily.${useMock ? 'mock' : 'live'}.json`);

// --- データ読み込み ---
const candles = loadOhlcvFromDailyCsv(join(DATA_DIR, 'btc-daily-2010-2026.csv'));
const newsByDate = groupNewsByUtcDate(loadNewsFromCsvGz(join(DATA_DIR, 'btc-news-2017-2026.csv.gz')));

const toDate = toDateOption ?? new Date(candles[candles.length - 1].time).toISOString().slice(0, 10);

const cache: Record<string, MarketContextLogEntry> = existsSync(cachePath)
  ? JSON.parse(readFileSync(cachePath, 'utf-8'))
  : {};

const saveCache = (): void => {
  writeFileSync(cachePath, JSON.stringify(cache, null, 1));
};

const utcDateOf = (timeMs: number): string => new Date(timeMs).toISOString().slice(0, 10);
const pctChange = (from: number, to: number): number => (to - from) / from;

/** endIndexの終値までを使った直近20日ボラティリティ（features.tsのvolatility20と同定義） */
function volatility20d(closes: number[], endIndex: number): number {
  const returns: number[] = [];
  for (let i = endIndex - 19; i <= endIndex; i++) {
    returns.push(pctChange(closes[i - 1], closes[i]));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

// --- 処理対象日の決定 ---
interface DayJob {
  date: string;
  input: MarketContextInput;
}

const closes = candles.map(c => c.close);
const jobs: DayJob[] = [];
let skippedCached = 0;

for (let i = 21; i < candles.length; i++) {
  const date = utcDateOf(candles[i].time);
  if (date < fromDate || date > toDate) continue;
  if (cache[date]) {
    skippedCached++;
    continue;
  }

  const dayNews = newsByDate.get(date) ?? [];
  jobs.push({
    date,
    input: {
      recentNews: selectTopHeadlines(dayNews),
      priceContext: {
        return24h: pctChange(closes[i - 1], closes[i]),
        volatility20d: volatility20d(closes, i),
      },
    },
  });
}

const targetJobs = jobs.slice(0, limit);

console.log(`=== ③LLM特徴量抽出 日次バッチ (${useMock ? 'mock' : `live: ${getConfiguredModel()}`}) ===`);
console.log(`期間: ${fromDate} 〜 ${toDate}`);
console.log(`キャッシュ済み: ${skippedCached}日 / 未処理: ${jobs.length}日 / 今回処理: ${targetJobs.length}日`);
console.log(`キャッシュ出力先: ${cachePath}\n`);

if (targetJobs.length === 0) {
  console.log('処理対象がありません。');
  process.exit(0);
}

// --- 実行 ---
let processed = 0;
let failed = 0;
const SAVE_INTERVAL = 20;

async function processJob(job: DayJob): Promise<void> {
  try {
    const entry = useMock ? mockAnalyzeMarketContext(job.input) : await analyzeMarketContext(job.input);
    cache[job.date] = entry;
    processed++;
    if (processed % SAVE_INTERVAL === 0) {
      saveCache();
      console.log(`  ... ${processed}/${targetJobs.length} 日処理済み（途中保存）`);
    }
  } catch (error) {
    failed++;
    console.error(`  [失敗] ${job.date}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (useMock) {
  for (const job of targetJobs) await processJob(job);
} else {
  // 同時 concurrency 件ずつ処理（レートリミット429はSDKが自動リトライ）
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < targetJobs.length) {
      const job = targetJobs[cursor++];
      await processJob(job);
    }
  });
  await Promise.all(workers);
}

saveCache();

// --- サマリー ---
const entries = Object.values(cache);
const withNews = entries.filter(e => e.input.recentNews.length > 0).length;
const nonZeroImpact = entries.filter(e => e.output.eventImpactScore !== 0).length;
const strongImpact = entries.filter(e => Math.abs(e.output.eventImpactScore) >= 0.5).length;

console.log(`\n完了: 今回 ${processed}日処理（失敗 ${failed}日）。キャッシュ合計 ${entries.length}日`);
console.log(`  ニュースあり: ${withNews}日 / eventImpactScore≠0: ${nonZeroImpact}日 / |impact|>=0.5(veto級): ${strongImpact}日`);
if (failed > 0) {
  console.log('  失敗した日付は再実行で自動的にリトライされます。');
}
