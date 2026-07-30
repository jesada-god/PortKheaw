/**
 * The decorative market field behind the authentication pages.
 *
 * Deliberately a hand-written SVG rather than the charting library the rest of
 * the app uses: this draws no data, so pulling `lightweight-charts` (and a
 * canvas, and a client component) onto the sign-in page to produce a backdrop
 * would be paying the whole charting bundle for wallpaper. The geometry is a
 * fixed literal so server and client render identical markup — a randomised
 * pattern would hydrate mismatched.
 *
 * `aria-hidden` with no title: it carries no information a screen reader user
 * would be missing.
 */

/** [x, open, close, low, high] in the 0–400 × 0–720 viewBox. */
const CANDLES: readonly (readonly [number, number, number, number, number])[] = [
  [24, 556, 528, 566, 518],
  [56, 528, 542, 552, 520],
  [88, 542, 496, 550, 486],
  [120, 496, 470, 508, 458],
  [152, 470, 486, 496, 462],
  [184, 486, 432, 492, 420],
  [216, 432, 408, 444, 396],
  [248, 408, 424, 434, 400],
  [280, 424, 366, 430, 352],
  [312, 366, 330, 378, 318],
  [344, 330, 348, 356, 322],
  [376, 348, 286, 354, 272],
];

const TREND = CANDLES.map(([x, , close]) => `${x},${close}`).join(' ');

export function AuthBackdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(165deg, var(--auth-field-top) 0%, var(--auth-field-mid) 46%, var(--auth-field-bottom) 100%)',
        }}
      />
      <svg
        data-auth-decor-drift
        viewBox="0 0 400 720"
        preserveAspectRatio="xMidYMax slice"
        className="absolute inset-0 h-full w-full"
        style={{ color: 'var(--auth-decor)' }}
      >
        <g opacity="0.30">
          {CANDLES.map(([x, open, close, low, high]) => (
            <g key={x}>
              <line x1={x} x2={x} y1={low} y2={high} stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <rect
                x={x - 7}
                y={Math.min(open, close)}
                width="14"
                height={Math.max(Math.abs(open - close), 3)}
                rx="3"
                fill="currentColor"
              />
            </g>
          ))}
        </g>
        <polyline
          points={TREND}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.55"
        />
        <path
          d="M376 286 L396 262 M396 262 L376 262 M396 262 L396 282"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.7"
        />
      </svg>
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(115% 68% at 50% 0%, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0) 62%)',
        }}
      />
    </div>
  );
}
