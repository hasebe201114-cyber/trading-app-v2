/**
 * ⑤リスク管理層 — サーキットブレーカー
 * 日次損失上限・最大ドローダウン上限（PJ000001 Phase3 KPI: 15%以内）を監視し、
 * 超過した場合は新規エントリーを停止する判定を行う。
 */
import { DEFAULT_RISK_LIMITS, type CircuitBreakerStatus, type EquityPoint, type RiskLimits } from './types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(timestamp: number): number {
  return Math.floor(timestamp / DAY_MS) * DAY_MS;
}

export function evaluateCircuitBreaker(
  equityHistory: EquityPoint[],
  limits: RiskLimits = DEFAULT_RISK_LIMITS,
): CircuitBreakerStatus {
  if (equityHistory.length === 0) {
    return { halted: false, reason: null, currentDrawdown: 0, dailyLoss: 0 };
  }

  const sorted = [...equityHistory].sort((a, b) => a.timestamp - b.timestamp);
  const latest = sorted[sorted.length - 1];

  // 直近ピークからのドローダウン
  const peakEquity = Math.max(...sorted.map(p => p.equity));
  const currentDrawdown = peakEquity > 0 ? (peakEquity - latest.equity) / peakEquity : 0;

  // 当日始値（当日最初のデータ点）からの損失
  const todayStart = startOfUtcDay(latest.timestamp);
  const todayPoints = sorted.filter(p => p.timestamp >= todayStart);
  const dayOpenEquity = todayPoints.length > 0 ? todayPoints[0].equity : latest.equity;
  const dailyLoss = dayOpenEquity > 0 ? (dayOpenEquity - latest.equity) / dayOpenEquity : 0;

  if (currentDrawdown >= limits.maxDrawdownRatio) {
    return {
      halted: true,
      reason: `最大ドローダウン上限(${(limits.maxDrawdownRatio * 100).toFixed(0)}%)を超過(現在${(currentDrawdown * 100).toFixed(1)}%)。全面停止し方針見直しが必要`,
      currentDrawdown,
      dailyLoss,
    };
  }

  if (dailyLoss >= limits.maxDailyLossRatio) {
    return {
      halted: true,
      reason: `当日の損失が上限(${(limits.maxDailyLossRatio * 100).toFixed(0)}%)を超過(現在${(dailyLoss * 100).toFixed(1)}%)。新規エントリーを停止`,
      currentDrawdown,
      dailyLoss,
    };
  }

  return { halted: false, reason: null, currentDrawdown, dailyLoss };
}
