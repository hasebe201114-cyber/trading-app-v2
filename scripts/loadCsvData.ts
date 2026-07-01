/**
 * scripts/data/*.csv (investing.com エクスポート形式) を OHLCV[] に変換する。
 * PoC専用の暫定ローダー（scripts/data/README.md参照）。
 */
import { readFileSync } from 'node:fs';
import type { OHLCV } from '../src/types/market.ts';

function parseVolume(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '-' || trimmed === '') return null;
  const multiplier = trimmed.endsWith('K') ? 1_000 : trimmed.endsWith('M') ? 1_000_000 : trimmed.endsWith('B') ? 1_000_000_000 : 1;
  const numeric = parseFloat(trimmed.replace(/[KMB]/, '').replace(/,/g, ''));
  return numeric * multiplier;
}

function parseNumber(raw: string): number {
  return parseFloat(raw.replace(/,/g, ''));
}

/**
 * CSV行分割（ダブルクオート内のカンマを無視する）。
 * このデータセットは日付("Aug 02, 2020")・価格("11,105.8")双方にクオート内カンマを含むため、
 * 単純な split(',') では誤分割する。
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

export function loadOhlcvFromCsv(path: string): OHLCV[] {
  const raw = readFileSync(path, 'utf-8').replace(/^﻿/, ''); // BOM除去
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const rows: OHLCV[] = [];

  // ヘッダー: "Date","Price","Open","High","Low","Vol.","Change %"
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 6) continue;
    const [dateStr, priceStr, openStr, highStr, lowStr, volStr] = fields;

    const volume = parseVolume(volStr);
    if (volume === null) continue; // 欠損行は除外（README参照）

    const time = new Date(dateStr).getTime();
    if (Number.isNaN(time)) continue;

    rows.push({
      time,
      open: parseNumber(openStr),
      high: parseNumber(highStr),
      low: parseNumber(lowStr),
      close: parseNumber(priceStr),
      volume,
    });
  }

  // 元データは新しい日付が先頭（降順）なので、時系列昇順に並べ替える
  rows.sort((a, b) => a.time - b.time);
  return rows;
}
