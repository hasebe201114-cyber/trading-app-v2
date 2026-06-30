/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Semantic colors — CSS変数参照なのでテーマ切替に追従する
        bg:           'var(--bg)',
        surface:      'var(--surface)',
        'surface-2':  'var(--surface-2)',
        line:         'var(--line)',
        'line-strong':'var(--line-strong)',
        'fg-1':       'var(--fg-1)',
        'fg-2':       'var(--fg-2)',
        'fg-3':       'var(--fg-3)',
        'fg-4':       'var(--fg-4)',
        'fg-on-accent':'var(--fg-on-accent)',
        // Sprout accent — RGB形式でopacity modifierに対応
        sprout: {
          DEFAULT: 'rgb(var(--tw-sprout) / <alpha-value>)',
          700:     'rgb(var(--tw-sprout-700) / <alpha-value>)',
          100:     'rgb(var(--tw-sprout-100) / <alpha-value>)',
        },
        // Fixed semantic colors — opacity modifierに対応（hex → Tailwindが自動変換）
        long:       '#00B574',
        'long-bg':  '#E6FAF1',
        short:      '#FF3B47',
        'short-bg': '#FFEAEC',
        warn:       '#FFA800',
        'warn-bg':  '#FFF4DC',
        info:       '#3B82F6',
        'info-bg':  '#E6F0FF',
        bitcoin:    '#F7931A',
      },
      fontFamily: {
        sans:    ['Inter', 'Noto Sans JP', 'system-ui', 'sans-serif'],
        mono:    ['JetBrains Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'monospace'],
        jp:      ['Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', 'sans-serif'],
        display: ['Space Mono', 'monospace'],
      },
      // rem単位: html font-size を変えるとアプリ全体がスケールする
      fontSize: {
        micro:   ['0.6875rem', { lineHeight: '1.25' }],          // 11px @ 16px root
        caption: ['0.75rem',   { lineHeight: '1.5'  }],          // 12px
        body:    ['0.9375rem', { lineHeight: '1.5'  }],          // 15px
        h3:      ['1.125rem',  { lineHeight: '1.25' }],          // 18px
        h2:      ['1.375rem',  { lineHeight: '1.25', fontWeight: '600' }], // 22px
        h1:      ['1.75rem',   { lineHeight: '1.25', letterSpacing: '-0.02em' }], // 28px
        display: ['2.5rem',    { lineHeight: '1.1',  letterSpacing: '-0.02em' }], // 40px
      },
      letterSpacing: {
        tight: '-0.02em',
        wide:  '0.04em',
        wider: '0.08em',
      },
      spacing: {
        1: '4px', 2: '8px',  3: '12px', 4: '16px',
        5: '20px', 6: '24px', 8: '32px', 12: '48px', 16: '64px',
      },
      borderRadius: {
        xs: '2px', sm: '6px', md: '10px', lg: '16px', xl: '24px', pill: '999px',
      },
      boxShadow: {
        1: '0 1px 2px rgba(11,12,15,0.04), 0 1px 1px rgba(11,12,15,0.06)',
        2: '0 2px 8px rgba(11,12,15,0.06), 0 1px 2px rgba(11,12,15,0.08)',
        3: '0 16px 32px rgba(11,12,15,0.12), 0 4px 8px rgba(11,12,15,0.08)',
        focus: '0 0 0 2px rgb(var(--tw-sprout))',
      },
      fontWeight: {
        '400': '400', '500': '500', '600': '600', '700': '700', '800': '800',
      },
      transitionTimingFunction: { snap: 'cubic-bezier(0.32, 0.72, 0, 1)' },
      transitionDuration: { fast: '120ms', base: '200ms', slow: '320ms' },
    },
  },
  plugins: [],
}
