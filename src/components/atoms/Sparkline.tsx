import React, { useId } from 'react';
import { AreaChart, Area, YAxis, ResponsiveContainer } from 'recharts';

interface SparklineProps {
  data: Array<{ value: number }>;
  height?: number;
  color?: string;
  showArea?: boolean;
}

export const Sparkline: React.FC<SparklineProps> = ({
  data,
  height = 32,
  color = '#00D68F',
  showArea = true,
}) => {
  const uid = useId();
  const gradientId = `spark-${uid.replace(/:/g, '')}`;

  if (!data || data.length === 0) {
    return <div className="w-full" style={{ height }} />;
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <YAxis
          hide
          domain={[
            (min: number) => Math.min(min, 0) * 1.3 - 0.05,
            (max: number) => Math.max(max, 0) * 1.3 + 0.05,
          ]}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={1.5}
          fill={showArea ? `url(#${gradientId})` : 'none'}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
};

/** price と 24h 変動率から合成スパークラインデータを生成 */
export function generateSparkline(price: number, change24h: number, points = 24): Array<{ value: number }> {
  const startPrice = price / (1 + change24h / 100);
  const result: Array<{ value: number }> = [];
  const seed = Math.abs(Math.round(price * 100)) % 1000;

  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    const trend = startPrice + (price - startPrice) * t;
    const noise = ((((seed * (i + 1) * 9301 + 49297) % 233280) / 233280) - 0.5) * price * 0.012;
    result.push({ value: trend + noise });
  }
  return result;
}
