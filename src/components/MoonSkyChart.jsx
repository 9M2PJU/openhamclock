/**
 * MoonSkyChart — polar sky chart (centre = zenith, edge = horizon) with one
 * or more moon sky tracks and moon markers. Lifted from SolarPanel's EME
 * block so the EME layout can draw DE and DX on the same dial.
 *
 * Defaults reproduce SolarPanel's original look exactly (amber dashed track,
 * green filled moon when up, hollow grey ring on the horizon at its azimuth
 * when below).
 */

const toXY = (C, R, az, el) => {
  const r = (R * (90 - Math.max(0, Math.min(90, el)))) / 90;
  const a = (az * Math.PI) / 180;
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
};

/**
 * @param {object} props
 * @param {number} [props.size=96]           dial size in px
 * @param {Array<{points:Array<{az:number,el:number}>, color?:string, dash?:string, opacity?:number}>} [props.tracks]
 * @param {Array<{az:number, el:number, color?:string, hollowColor?:string, label?:string}>} [props.markers]
 * @param {string} [props.ariaLabel]
 */
export function MoonSkyChart({ size = 96, tracks = [], markers = [], ariaLabel = 'Moon sky position' }) {
  const DIAL = size;
  const C = DIAL / 2;
  const R = DIAL * (40 / 96);
  const fs = Math.max(6, DIAL * (7 / 96));
  return (
    <svg width={DIAL} height={DIAL} viewBox={`0 0 ${DIAL} ${DIAL}`} role="img" aria-label={ariaLabel}>
      {/* Horizon + elevation rings (0/30/60°), zenith at center */}
      <circle cx={C} cy={C} r={R} fill="var(--bg-tertiary)" stroke="var(--border-color)" strokeWidth="1" />
      <circle cx={C} cy={C} r={(R * 2) / 3} fill="none" stroke="var(--border-color)" strokeWidth="0.5" opacity="0.7" />
      <circle cx={C} cy={C} r={R / 3} fill="none" stroke="var(--border-color)" strokeWidth="0.5" opacity="0.7" />
      <line x1={C} y1={C - R} x2={C} y2={C + R} stroke="var(--border-color)" strokeWidth="0.5" opacity="0.5" />
      <line x1={C - R} y1={C} x2={C + R} y2={C} stroke="var(--border-color)" strokeWidth="0.5" opacity="0.5" />
      <text x={C} y={fs} textAnchor="middle" fontSize={fs} fill="var(--text-muted)">
        N
      </text>
      <text x={DIAL - 3} y={C + fs * 0.36} textAnchor="end" fontSize={fs} fill="var(--text-muted)">
        E
      </text>
      <text x={C} y={DIAL - 1} textAnchor="middle" fontSize={fs} fill="var(--text-muted)">
        S
      </text>
      <text x={3} y={C + fs * 0.36} textAnchor="start" fontSize={fs} fill="var(--text-muted)">
        W
      </text>
      {/* Sky tracks for the coming pass */}
      {tracks.map((tr, i) => {
        const pts = (tr.points || []).map(({ az, el }) => toXY(C, R, az, el).join(',')).join(' ');
        if (!pts) return null;
        return (
          <polyline
            key={i}
            points={pts}
            fill="none"
            stroke={tr.color || 'var(--accent-amber)'}
            strokeWidth="1.2"
            strokeDasharray={tr.dash ?? '2,2'}
            opacity={tr.opacity ?? 0.8}
          />
        );
      })}
      {/* The moon: filled when up, hollow on the horizon ring at its azimuth
          when below (shows where it is coming up) */}
      {markers.map((m, i) => {
        if (!Number.isFinite(m.az) || !Number.isFinite(m.el)) return null;
        const up = m.el >= 0;
        const [mx, my] = up ? toXY(C, R, m.az, m.el) : toXY(C, R, m.az, 0);
        return up ? (
          <circle
            key={i}
            cx={mx}
            cy={my}
            r={DIAL * (4.5 / 96)}
            fill={m.color || 'var(--accent-green)'}
            stroke="var(--bg-primary)"
            strokeWidth="1"
          >
            {m.label && <title>{m.label}</title>}
          </circle>
        ) : (
          <circle
            key={i}
            cx={mx}
            cy={my}
            r={DIAL * (3.5 / 96)}
            fill="none"
            stroke={m.hollowColor || m.color || 'var(--text-muted)'}
            strokeWidth="1.5"
          >
            {m.label && <title>{m.label}</title>}
          </circle>
        );
      })}
    </svg>
  );
}

export default MoonSkyChart;
