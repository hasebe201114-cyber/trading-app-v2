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
