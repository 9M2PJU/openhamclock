/**
 * DXNewsTicker Component
 * Scrolling news banner showing latest DX news headlines from dxnews.com
 */
import React, { useState, useEffect, useRef } from 'react';

export const DXNewsTicker = ({ sidebar = false }) => {
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(true);
  const tickerRef = useRef(null);
  const contentRef = useRef(null);
  const [animDuration, setAnimDuration] = useState(120);

  // Fetch news
  useEffect(() => {
    const fetchNews = async () => {
      try {
        const res = await fetch('/api/dxnews');
        if (res.ok) {
          const data = await res.json();
          if (data.items && data.items.length > 0) {
            setNews(data.items);
          }
        }
      } catch (err) {
        console.error('DX News ticker fetch error:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchNews();
    // Refresh every 30 minutes
    const interval = setInterval(fetchNews, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Calculate animation duration based on content width
  useEffect(() => {
    if (contentRef.current && tickerRef.current) {
      const contentWidth = contentRef.current.scrollWidth;
      const containerWidth = tickerRef.current.offsetWidth;
      // ~90px per second scroll speed
      const duration = Math.max(20, (contentWidth + containerWidth) / 90);
      setAnimDuration(duration);
    }
  }, [news]);

  if (loading || news.length === 0) return null;

  // Build ticker text: "TITLE — description  ★  TITLE — description  ★  ..."
  const tickerItems = news.map(item => ({
    title: item.title,
    desc: item.description
  }));

  return (
    <div
      ref={tickerRef}
      style={sidebar ? {
        width: '100%',
        height: '100%',
        background: 'transparent',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center'
      } : {
        position: 'absolute',
        bottom: '8px',
        left: '8px',
        right: '50%',
        height: '28px',
        background: 'rgba(0, 0, 0, 0.85)',
        border: '1px solid #444',
        borderRadius: '6px',
        overflow: 'hidden',
        zIndex: 999,
        display: 'flex',
        alignItems: 'center'
      }}
    >
      {/* DX NEWS label */}
      <div style={{
        background: 'rgba(255, 136, 0, 0.9)',
        color: '#000',
        fontWeight: '700',
        fontSize: '10px',
        fontFamily: 'JetBrains Mono, monospace',
        padding: '0 8px',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0,
        borderRight: '1px solid #444',
        letterSpacing: '0.5px'
      }}>
        📰 DX NEWS
      </div>

      {/* Scrolling content */}
      <div style={{
        flex: 1,
        overflow: 'hidden',
        position: 'relative',
        height: '100%',
        maskImage: 'linear-gradient(to right, transparent 0%, black 3%, black 97%, transparent 100%)',
        WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 3%, black 97%, transparent 100%)'
      }}>
        <div
          ref={contentRef}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            height: '100%',
            whiteSpace: 'nowrap',
            animation: `dxnews-scroll ${animDuration}s linear infinite`,
            paddingLeft: '100%'
          }}
        >
          {tickerItems.map((item, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>
              <span style={{
                color: '#ff8800',
                fontWeight: '700',
                fontSize: '11px',
                fontFamily: 'JetBrains Mono, monospace',
                marginRight: '6px'
              }}>
                {item.title}
              </span>
              <span style={{
                color: '#aaa',
                fontSize: '11px',
                fontFamily: 'JetBrains Mono, monospace',
                marginRight: '12px'
              }}>
                {item.desc}
              </span>
              <span style={{
                color: '#555',
                fontSize: '10px',
                marginRight: '12px'
              }}>
                ◆
              </span>
            </span>
          ))}
          {/* Duplicate for seamless loop */}
          {tickerItems.map((item, i) => (
            <span key={`dup-${i}`} style={{ display: 'inline-flex', alignItems: 'center' }}>
              <span style={{
                color: '#ff8800',
                fontWeight: '700',
                fontSize: '11px',
                fontFamily: 'JetBrains Mono, monospace',
                marginRight: '6px'
              }}>
                {item.title}
              </span>
              <span style={{
                color: '#aaa',
                fontSize: '11px',
                fontFamily: 'JetBrains Mono, monospace',
                marginRight: '12px'
              }}>
                {item.desc}
              </span>
              <span style={{
                color: '#555',
                fontSize: '10px',
                marginRight: '12px'
              }}>
                ◆
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

export default DXNewsTicker;
