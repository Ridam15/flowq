/** @type {import('tailwindcss').Config} */
// FlowQ dashboard theme.
//
// We pin a small palette here rather than leaning on Tailwind's defaults
// because every accent in the UI carries semantic meaning (healthy /
// warning / error). Hand-picking the values keeps that vocabulary
// consistent across components — a `text-flow-success` always means the
// same thing.
//
// Naming choice: `flow-*` prefix avoids collision with Tailwind's built-in
// `green-*`, `red-*` palettes so we never accidentally use a stock
// Tailwind shade where a semantic one was intended.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Background scale: deepest at the page root, lighter for
        // surfaces, lighter still for hover/raised states.
        flow: {
          bg: '#0f1117',        // page background
          surface: '#151823',    // card / panel background
          raised: '#1c2030',     // hovered or elevated surface
          border: '#262b3d',     // hairline borders, table separators
          mute: '#3a4055',       // disabled / placeholder text
          text: '#e2e6f3',       // primary text
          dim: '#8b93ad',        // secondary text / labels
          success: '#00ff88',    // healthy, completed
          warn: '#ffaa00',       // stalled heartbeat, paused
          danger: '#ff4444',     // failed, dead, errors
          accent: '#5e8cff',     // links, focused states
        },
      },
      fontFamily: {
        // Tailwind's default `font-mono` is `ui-monospace, SFMono-Regular, …`.
        // We make that explicit and prepend JetBrains Mono / Fira Code so
        // the metric panes render with a true monospace even on systems
        // missing the SF system font.
        mono: [
          'JetBrains Mono',
          'Fira Code',
          'SFMono-Regular',
          'ui-monospace',
          'Menlo',
          'monospace',
        ],
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
      boxShadow: {
        // Subtle inner glow on focused inputs — matches the SRE-tool
        // aesthetic without using Tailwind's default blue ring.
        'flow-focus': '0 0 0 1px #5e8cff inset',
      },
      keyframes: {
        // Pulsing dot used for "live / connected" indicator.
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },
      animation: {
        'pulse-dot': 'pulse-dot 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
