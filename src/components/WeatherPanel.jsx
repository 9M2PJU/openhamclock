/**
 * WeatherPanel Component
 * Displays current weather conditions with expandable forecast details
 * for a given location. Uses Open-Meteo API via the useLocalWeather hook.
 */
import React, { useState } from 'react';
import { useLocalWeather } from '../hooks';

export const WeatherPanel = ({ location, tempUnit, onTempUnitChange }) => {
  const [weatherExpanded, setWeatherExpanded] = useState(() => {
    try { return localStorage.getItem('openhamclock_weatherExpanded') === 'true'; } catch { return false; }
  });

  const localWeather = useLocalWeather(location, tempUnit);

  if (!localWeather.data) return null;

  const w = localWeather.data;
  const deg = `°${w.tempUnit || tempUnit}`;
  const wind = w.windUnit || 'mph';
  const vis = w.visUnit || 'mi';

  return (
    <div style={{ marginTop: '12px', borderTop: '1px solid var(--border-color)', paddingTop: '10px' }}>
      {/* Compact summary row — always visible */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div
          onClick={() => { const next = !weatherExpanded; setWeatherExpanded(next); try { localStorage.setItem('openhamclock_weatherExpanded', next.toString()); } catch {} }}
          style={{
            display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer',
            userSelect: 'none', flex: 1, minWidth: 0,
          }}
        >
          <span style={{ fontSize: '20px', lineHeight: 1 }}>{w.icon}</span>
          <span style={{ fontSize: '18px', fontWeight: '700', color: 'var(--text-primary)', fontFamily: 'Orbitron, monospace' }}>
            {w.temp}{deg}
          </span>
          <span style={{ fontSize: '11px', color: 'var(--text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.description}</span>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
            💨{w.windSpeed}
          </span>
          <span style={{
            fontSize: '10px', color: 'var(--text-muted)',
            transform: weatherExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s',
          }}>▼</span>
        </div>
        {/* F/C toggle */}
        {onTempUnitChange && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onTempUnitChange(tempUnit === 'F' ? 'C' : 'F');
            }}
            style={{
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border-color)',
              color: 'var(--text-secondary)',
              fontSize: '10px',
              padding: '1px 5px',
              borderRadius: '3px',
              cursor: 'pointer',
              fontFamily: 'JetBrains Mono, monospace',
              fontWeight: '600',
              flexShrink: 0,
            }}
            title={`Switch to °${tempUnit === 'F' ? 'C' : 'F'}`}
          >
            °{tempUnit === 'F' ? 'C' : 'F'}
          </button>
        )}
      </div>

      {/* Expanded details */}
      {weatherExpanded && (
        <div style={{ marginTop: '10px' }}>
          {/* Feels like + hi/lo */}
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '8px', fontFamily: 'JetBrains Mono, monospace' }}>
            {w.feelsLike !== w.temp && (
              <span style={{ color: 'var(--text-muted)' }}>Feels like {w.feelsLike}{deg}</span>
            )}
            {w.todayHigh != null && (
              <span style={{ color: 'var(--text-muted)', marginLeft: 'auto' }}>
                <span style={{ color: 'var(--accent-amber)' }}>▲{w.todayHigh}°</span>
                {' '}
                <span style={{ color: 'var(--accent-blue)' }}>▼{w.todayLow}°</span>
              </span>
            )}
          </div>

          {/* Detail grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '6px 12px',
            fontSize: '11px',
            fontFamily: 'JetBrains Mono, monospace',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)' }}>💨 Wind</span>
              <span style={{ color: 'var(--text-secondary)' }}>{w.windDir} {w.windSpeed} {wind}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)' }}>💧 Humidity</span>
              <span style={{ color: 'var(--text-secondary)' }}>{w.humidity}%</span>
            </div>
            {w.windGusts > w.windSpeed + 5 && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>🌬️ Gusts</span>
                <span style={{ color: 'var(--text-secondary)' }}>{w.windGusts} {wind}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)' }}>🌡️ Dew Pt</span>
              <span style={{ color: 'var(--text-secondary)' }}>{w.dewPoint}{deg}</span>
            </div>
            {w.pressure && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>🔵 Pressure</span>
                <span style={{ color: 'var(--text-secondary)' }}>{w.pressure} hPa</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-muted)' }}>☁️ Clouds</span>
              <span style={{ color: 'var(--text-secondary)' }}>{w.cloudCover}%</span>
            </div>
            {w.visibility && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>👁️ Vis</span>
                <span style={{ color: 'var(--text-secondary)' }}>{w.visibility} {vis}</span>
              </div>
            )}
            {w.uvIndex > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>☀️ UV</span>
                <span style={{ color: w.uvIndex >= 8 ? '#ef4444' : w.uvIndex >= 6 ? '#f97316' : w.uvIndex >= 3 ? '#eab308' : 'var(--text-secondary)' }}>
                  {w.uvIndex.toFixed(1)}
                </span>
              </div>
            )}
          </div>

          {/* 3-Day Forecast */}
          {w.daily?.length > 0 && (
            <div style={{
              marginTop: '10px',
              paddingTop: '8px',
              borderTop: '1px solid var(--border-color)',
            }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px', fontWeight: '600' }}>FORECAST</div>
              <div style={{ display: 'flex', gap: '4px' }}>
                {w.daily.map((day, i) => (
                  <div key={i} style={{
                    flex: 1,
                    textAlign: 'center',
                    padding: '6px 2px',
                    background: 'var(--bg-tertiary)',
                    borderRadius: '4px',
                    fontSize: '10px',
                  }}>
                    <div style={{ color: 'var(--text-muted)', fontWeight: '600', marginBottom: '2px' }}>{i === 0 ? 'Today' : day.date}</div>
                    <div style={{ fontSize: '16px', lineHeight: 1.2 }}>{day.icon}</div>
                    <div style={{ fontFamily: 'JetBrains Mono, monospace', marginTop: '2px' }}>
                      <span style={{ color: 'var(--accent-amber)' }}>{day.high}°</span>
                      <span style={{ color: 'var(--text-muted)' }}>/</span>
                      <span style={{ color: 'var(--accent-blue)' }}>{day.low}°</span>
                    </div>
                    {day.precipProb > 0 && (
                      <div style={{ color: 'var(--accent-blue)', fontSize: '9px', marginTop: '1px' }}>
                        💧{day.precipProb}%
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default WeatherPanel;
