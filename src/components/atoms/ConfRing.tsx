import React from 'react';

interface ConfRingProps {
  value: number;
  size?: number;
  label?: string;
}

export const ConfRing: React.FC<ConfRingProps> = ({ value, size = 60, label }) => {
  const r = size / 2 - 4;
  const circumference = 2 * Math.PI * r;
  const offset = circumference - (value / 100) * circumference;

  const color =
    value < 30 ? '#FF3B47' :
    value < 60 ? '#FFA800' :
    '#00D68F';

  const fontSize = size < 50 ? size * 0.28 : size * 0.26;

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size}>
        {/* 背景円 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={size < 50 ? 3 : 4}
          className="text-line dark:text-line"
        />
        {/* 進捗円（-90° offset） */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={size < 50 ? 3 : 4}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          className="transition-all duration-500"
        />
        {/* 中央テキスト */}
        <text
          x={size / 2}
          y={size / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fill={color}
          fontWeight="700"
          fontSize={fontSize}
          fontFamily="inherit"
        >
          {value.toFixed(0)}
        </text>
      </svg>
      {label && (
        <div className="text-micro text-fg-3 dark:text-fg-3 mt-1">{label}</div>
      )}
    </div>
  );
};
