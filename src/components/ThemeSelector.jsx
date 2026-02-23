import { PREBUILT_THEMES } from '../theme/themeConfig';

export default function ThemeSelector({ id, theme, setTheme }) {
  return (
    <div id={id} style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '8px' }}>
      {Object.entries(PREBUILT_THEMES).map(([key, t]) => (
        <button
          className={`${key}-button`}
          key={key}
          onClick={() => setTheme(key)}
          style={{
            padding: '10px',
            background: 'var(--bg-tertiary)',
            border: '1px solid var(--border-color)',
            borderRadius: '6px',
            color: 'var(--text-secondary)',
            fontSize: '12px',
            cursor: 'pointer',
            fontWeight: '400',
          }}
        >
          {t.icon} {t.label}
        </button>
      ))}
    </div>
  );
}
