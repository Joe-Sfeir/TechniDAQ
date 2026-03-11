/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['"Share Tech Mono"', 'Courier New', 'monospace'],
        display: ['"Rajdhani"', 'sans-serif'],
      },
      colors: {
        obsidian: {
          950: '#050608',
          900: '#0a0c0f',
          800: '#0f1318',
          700: '#161b24',
          600: '#1e2530',
        },
        volt: {
          DEFAULT: '#00e5a0',
          dim: '#00e5a020',
          glow: '#00e5a040',
        },
        ampere: {
          DEFAULT: '#38bdf8',
          dim: '#38bdf820',
          glow: '#38bdf840',
        },
        watt: {
          DEFAULT: '#f59e0b',
          dim: '#f59e0b20',
          glow: '#f59e0b40',
        },
        joule: {
          DEFAULT: '#a78bfa',
          dim: '#a78bfa20',
          glow: '#a78bfa40',
        },
      },
      animation: {
        'pulse-slow': 'pulse 2.5s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'flicker': 'flicker 4s linear infinite',
        'scan': 'scan 8s linear infinite',
      },
      keyframes: {
        flicker: {
          '0%, 95%, 100%': { opacity: '1' },
          '96%': { opacity: '0.85' },
          '97%': { opacity: '1' },
          '98%': { opacity: '0.9' },
        },
        scan: {
          '0%': { transform: 'translateY(-100%)' },
          '100%': { transform: 'translateY(100vh)' },
        },
      },
      boxShadow: {
        'volt': '0 0 20px #00e5a030, inset 0 0 20px #00e5a008',
        'ampere': '0 0 20px #38bdf830, inset 0 0 20px #38bdf808',
        'watt': '0 0 20px #f59e0b30, inset 0 0 20px #f59e0b08',
        'joule': '0 0 20px #a78bfa30, inset 0 0 20px #a78bfa08',
        'panel': '0 4px 24px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.04)',
      },
    },
  },
  plugins: [],
}