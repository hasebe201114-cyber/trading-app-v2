// 価格の大きさに基づいて適切な小数点桁数を決定
export const getDecimalPlaces = (price: number): number => {
  if (price >= 100) return 2;      // BTC, ETH など
  if (price >= 1) return 4;        // SOL, UNI, ADA など
  if (price >= 0.1) return 6;      // DOGE など
  if (price >= 0.01) return 8;     // MEME など
  return 10;                        // 0.01以下
};

export const formatPrice = (price: number): string => {
  const decimals = getDecimalPlaces(price);
  return `$${price.toLocaleString('ja-JP', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
};

// UTC ISO文字列（例: "2026-07-12T04:24:39.660Z"）を日本時間(JST=UTC+9)の "YYYY-MM-DD HH:MM" に変換。
// バックエンド（GitHub Actions等）はUTCで記録するため、表示側でJSTへ変換して統一する。
export const formatJST = (isoUTC: string): string => {
  const d = new Date(isoUTC);
  if (Number.isNaN(d.getTime())) return isoUTC;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
};
