/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        parkx: {
          black: '#080808',
          dark: '#0d0d0d',
          surface: '#141414',
          card: 'rgba(20, 20, 20, 0.65)',
          border: 'rgba(255, 255, 255, 0.08)',
          'border-bright': 'rgba(255, 255, 255, 0.2)',
          accent: '#2ee6ca',
          'accent-dim': 'rgba(46, 230, 202, 0.15)',
          'accent-glow': 'rgba(46, 230, 202, 0.35)',
          muted: '#8e8e93',
          dim: '#3a3a3c'
        }
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        display: ['"Space Grotesk"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace']
      },
      letterSpacing: {
        'ultra-wide': '0.25em',
        'mega-wide': '0.35em'
      }
    },
  },
  plugins: [],
}
