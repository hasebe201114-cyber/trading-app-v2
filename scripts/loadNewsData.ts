/**
 * scripts/data/btc-news-2017-2026.csv.gz（CryptoPanicアーカイブのBTC抽出版）を読み込み、
 * UTC日付ごとのニュースに整理する。③LLM特徴量抽出（OBS000014）用。
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export interface NewsItem {
  /** "YYYY-MM-DD HH:MM:SS" (UTC) */
  datetime: string;
  title: string;
  important: number;
  positive: number;
  negative: number;
  sourceDomain: string;
}

/** CSV行分割（ダブルクオート対応。クオート内のカンマ・二重クオートのエスケープを処理） */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

export function loadNewsFromCsvGz(path: string): NewsItem[] {
  const csv = gunzipSync(readFileSync(path)).toString('utf-8');
  const lines = csv.split('\n').filter(l => l.trim().length > 0);
  const items: NewsItem[] = [];

  // ヘッダー: datetime,title,important,positive,negative,sourceDomain
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    if (f.length < 6) continue;
    items.push({
      datetime: f[0],
      title: f[1],
      important: parseInt(f[2], 10) || 0,
      positive: parseInt(f[3], 10) || 0,
      negative: parseInt(f[4], 10) || 0,
      sourceDomain: f[5],
    });
  }
  return items;
}

/** UTC日付("YYYY-MM-DD") → その日のニュース一覧 */
export function groupNewsByUtcDate(items: NewsItem[]): Map<string, NewsItem[]> {
  const map = new Map<string, NewsItem[]>();
  for (const item of items) {
    const date = item.datetime.slice(0, 10);
    const list = map.get(date);
    if (list) list.push(item);
    else map.set(date, [item]);
  }
  return map;
}

/**
 * その日のニュースから、LLMに渡す上位 maxItems 件のタイトルを選ぶ。
 * 重要フラグ投票→リアクション総数の順で優先し、同点は時刻順。タイトルは maxTitleLength で切り詰める。
 */
export function selectTopHeadlines(
  news: NewsItem[],
  maxItems = 12,
  maxTitleLength = 160,
): string[] {
  const scored = [...news].sort((a, b) => {
    if (b.important !== a.important) return b.important - a.important;
    const reactionsA = a.positive + a.negative;
    const reactionsB = b.positive + b.negative;
    if (reactionsB !== reactionsA) return reactionsB - reactionsA;
    return a.datetime.localeCompare(b.datetime);
  });
  return scored.slice(0, maxItems).map(n => {
    const title = n.title.length > maxTitleLength ? `${n.title.slice(0, maxTitleLength)}…` : n.title;
    return `${title} (${n.sourceDomain})`;
  });
}
