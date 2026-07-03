/**
 * scripts/data/*-funding-*.csv（datetime,funding_rate の8時間おきイベント）を読み込み、
 * UTC日次に集約する。1日あたり最大3回（8時間おき）の支払いを合計し、
 * 「その日ポジションを持ち越した場合の日次ファンディング損益率」として扱う。
 */
import { readFileSync } from 'node:fs';

export interface DailyFundingRate {
  date: string; // UTC日付 YYYY-MM-DD
  fundingRateDaily: number; // その日の支払いイベントの合計（符号付き。正=ロングがショートに支払う）
  eventCount: number;
}

export function loadDailyFundingRate(path: string): Map<string, DailyFundingRate> {
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.trim().split('\n');
  const byDate = new Map<string, DailyFundingRate>();

  for (let i = 1; i < lines.length; i++) {
    const [datetime, rateStr] = lines[i].split(',');
    const date = datetime.slice(0, 10);
    const rate = parseFloat(rateStr);
    const existing = byDate.get(date);
    if (existing) {
      existing.fundingRateDaily += rate;
      existing.eventCount += 1;
    } else {
      byDate.set(date, { date, fundingRateDaily: rate, eventCount: 1 });
    }
  }
  return byDate;
}
