import type { Config } from 'tailwindcss'

const config: Config = {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      fontSize: {
        '2xs': ['11px', '16px'],
        xs: ['12px', '18px'],
        sm: ['13px', '20px'],
        lg: ['16px', '22px'],
        title: ['22px', '28px'],
        display: ['26px', '32px'],
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        level: {
          low: 'hsl(var(--level-low))',
          mid: 'hsl(var(--level-mid))',
          high: 'hsl(var(--level-high))',
          alert: 'hsl(var(--level-alert))',
        },
        ok: {
          DEFAULT: 'hsl(var(--ok))',
          soft: 'hsl(var(--ok-soft))',
        },
        warn: {
          DEFAULT: 'hsl(var(--warn))',
          soft: 'hsl(var(--warn-soft))',
        },
        err: {
          DEFAULT: 'hsl(var(--err))',
          soft: 'hsl(var(--err-soft))',
        },
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
        },
        console: {
          DEFAULT: 'hsl(var(--console-bg))',
          elev: 'hsl(var(--console-elev))',
          border: 'hsl(var(--console-border))',
          fg: 'hsl(var(--console-fg))',
          muted: 'hsl(var(--console-muted))',
        },
        elev: 'hsl(var(--bg-elev) / <alpha-value>)',
        sunken: 'hsl(var(--bg-sunken) / <alpha-value>)',
        strong: 'hsl(var(--border-strong) / <alpha-value>)',
        'fg-dim': 'hsl(var(--fg-dim) / <alpha-value>)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        sans: ['Geist', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}

export default config
