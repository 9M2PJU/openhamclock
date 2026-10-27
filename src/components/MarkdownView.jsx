/**
 * MarkdownView — small dependency-free markdown → React renderer.
 *
 * Covers exactly what docs/MANUAL.md uses (plus a couple of safety
 * extras): #/##/### headings (any level 1–6 accepted), paragraphs,
 * **bold**, *italic* / _italic_, `code`, fenced code blocks, links,
 * unordered/ordered lists (one nesting level), tables, blockquotes,
 * horizontal rules, images (`![alt](src)`), and the manual's screenshot
 * galleries (an HTML `<table>` of `<img>` + `<sub>` cells, which GitHub
 * renders side by side) — those are parsed into a grid, never injected.
 *
 * Everything renders as React elements — no dangerouslySetInnerHTML.
 * Headings get GitHub-style slug ids (utils/slugify.js) so #anchors
 * from the manual's own table of contents and from helpTopics.js
 * resolve. Internal #anchor links scroll within the view; external
 * links open in a new tab; relative .md links resolve to GitHub.
 */
import React, { useRef, useCallback, useMemo } from 'react';
import { createSlugger } from '../utils/slugify.js';

/** Where relative links in docs/MANUAL.md live on GitHub. */
const GITHUB_DOCS_BASE = 'https://github.com/accius/openhamclock/blob/main/docs/';

/** Resolve a MANUAL.md-relative href ("../CONTRIBUTING.md#x") to GitHub. */
function resolveRelativeHref(href) {
  const [pathPart, hash] = href.split('#');
  const base = GITHUB_DOCS_BASE.split('/');
  base.pop(); // trailing empty segment from the final "/"
  const segments = pathPart.split('/');
  for (const seg of segments) {
    if (seg === '..') base.pop();
    else if (seg !== '.' && seg !== '') base.push(seg);
  }
  return base.join('/') + (hash ? `#${hash}` : '');
}

/** Extract headings (outside code fences) for TOC building. */
export function extractHeadings(markdown) {
  const slugger = createSlugger();
  const headings = [];
  let inFence = false;
  // CRLF sources (Windows checkouts / self-hosted files) must parse the same
  // as LF: `.` never matches \r, so `^#+ (.*)$` fails on every heading line.
  for (const line of String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const text = stripInlineMarkdown(m[2].trim());
      headings.push({ level: m[1].length, text, id: slugger(text) });
    }
  }
  return headings;
}

/** Plain-text version of an inline-markdown string (for TOC labels / slugs). */
export function stripInlineMarkdown(text) {
  return String(text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/(^|[\s(])_([^_]+)_(?=$|[\s.,;:!?)])/g, '$1$2');
}

// ── Inline parsing ──────────────────────────────────────────────────

// Ordered alternation: code span, bold, image, link, *italic*, _italic_
const INLINE_RE =
  /`([^`]+)`|\*\*([^*]+)\*\*|!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*)\*|(^|[\s(])_([^_]+)_(?=$|[\s.,;:!?)])/;

const defaultImageRenderer = (alt, src, key) => (
  <img key={key} src={src} alt={alt} loading="lazy" style={{ maxWidth: '100%', borderRadius: '6px' }} />
);

export function parseInline(text, keyPrefix, linkRenderer, imageRenderer = defaultImageRenderer) {
  const nodes = [];
  let rest = String(text);
  let i = 0;
  while (rest) {
    const m = rest.match(INLINE_RE);
    if (!m) {
      nodes.push(rest);
      break;
    }
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    const key = `${keyPrefix}-${i++}`;
    if (m[1] !== undefined) {
      nodes.push(
        <code
          key={key}
          style={{
            background: 'var(--bg-tertiary)',
            padding: '1px 5px',
            borderRadius: '3px',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.9em',
          }}
        >
          {m[1]}
        </code>,
      );
    } else if (m[2] !== undefined) {
      nodes.push(<strong key={key}>{parseInline(m[2], key, linkRenderer, imageRenderer)}</strong>);
    } else if (m[4] !== undefined) {
      nodes.push(imageRenderer(m[3] || '', m[4], key));
    } else if (m[5] !== undefined) {
      nodes.push(linkRenderer(m[5], m[6], key));
    } else if (m[7] !== undefined) {
      nodes.push(<em key={key}>{parseInline(m[7], key, linkRenderer, imageRenderer)}</em>);
    } else if (m[9] !== undefined) {
      // _italic_ — m[8] is the leading whitespace/paren we must keep
      if (m[8]) nodes.push(m[8]);
      nodes.push(<em key={key}>{parseInline(m[9], key, linkRenderer, imageRenderer)}</em>);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return nodes;
}

// ── Block parsing ───────────────────────────────────────────────────

export function parseBlocks(markdown) {
  const lines = String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Fenced code block
    if (/^```/.test(trimmed)) {
      const lang = trimmed.slice(3).trim();
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push({ type: 'codeblock', lang, code: code.join('\n') });
      continue;
    }

    // Heading
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(trimmed)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        quote.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', text: quote.join('\n') });
      continue;
    }

    // Screenshot gallery: an HTML <table> whose cells hold <img> + <sub>
    // (the manual's side-by-side layout on GitHub). Parsed, not injected.
    if (/^<table\b/i.test(trimmed)) {
      const html = [];
      while (i < lines.length) {
        html.push(lines[i]);
        const done = /<\/table>/i.test(lines[i]);
        i++;
        if (done) break;
      }
      const src = html.join('\n');
      const rows = src.split(/<tr\b[^>]*>/i).slice(1);
      const cols = rows.length ? (rows[0].match(/<td\b/gi) || []).length : 0;
      const items = [];
      const cellRe = /<img\b([^>]*)>(?:\s*<br\s*\/?>)?\s*(?:<sub>([\s\S]*?)<\/sub>)?/gi;
      let m;
      while ((m = cellRe.exec(src))) {
        const attrs = m[1] || '';
        const srcAttr = attrs.match(/\bsrc="([^"]+)"/);
        if (!srcAttr) continue;
        const altAttr = attrs.match(/\balt="([^"]*)"/);
        const alt = altAttr ? altAttr[1] : '';
        items.push({ src: srcAttr[1], alt, caption: (m[2] || alt).trim() });
      }
      if (items.length) blocks.push({ type: 'gallery', items, cols: Math.max(1, cols || 2) });
      continue;
    }

    // Table (a | line followed by a |---| separator)
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|[\s:|-]+\|?$/.test(lines[i + 1].trim())) {
      const parseRow = (row) =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());
      const header = parseRow(trimmed);
      i += 2; // skip separator
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    // Lists (unordered and ordered, one nesting level via indentation)
    const ulRe = /^([ \t]*)[-*+]\s+(.*)$/;
    const olRe = /^([ \t]*)(\d+)\.\s+(.*)$/;
    if (ulRe.test(line) || olRe.test(line)) {
      const ordered = olRe.test(line) && !ulRe.test(line);
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const mu = l.match(ulRe);
        const mo = l.match(olRe);
        const m = ordered ? mo : mu;
        if (m) {
          const indent = m[1].replace(/\t/g, '  ').length;
          const text = ordered ? m[3] : m[2];
          if (indent >= 2 && items.length > 0) {
            items[items.length - 1].children.push(text);
          } else {
            items.push({ text, children: [] });
          }
          i++;
        } else if (l.trim() && /^[ \t]{2,}\S/.test(l) && items.length > 0 && !ulRe.test(l) && !olRe.test(l)) {
          // Continuation line of the previous item
          items[items.length - 1].text += ' ' + l.trim();
          i++;
        } else {
          break;
        }
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    // Paragraph — merge until a blank line or another block type
    const para = [trimmed];
    i++;
    while (i < lines.length) {
      const nxt = lines[i];
      const nt = nxt.trim();
      if (
        !nt ||
        /^(#{1,6})\s/.test(nt) ||
        /^```/.test(nt) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(nt) ||
        /^>\s?/.test(nt) ||
        nt.startsWith('|') ||
        /^<table\b/i.test(nt) ||
        ulRe.test(nxt) ||
        olRe.test(nxt)
      )
        break;
      para.push(nt);
      i++;
    }
    blocks.push({ type: 'paragraph', text: para.join(' ') });
  }

  return blocks;
}

// ── Component ───────────────────────────────────────────────────────

const headingStyles = {
  1: { fontSize: '22px', color: 'var(--accent-cyan)', margin: '8px 0 16px' },
  2: {
    fontSize: '18px',
    color: 'var(--accent-amber)',
    margin: '28px 0 12px',
    paddingBottom: '6px',
    borderBottom: '1px solid var(--border-color)',
  },
  3: { fontSize: '15px', color: 'var(--accent-cyan)', margin: '20px 0 10px' },
  4: { fontSize: '13px', color: 'var(--text-primary)', margin: '16px 0 8px' },
  5: { fontSize: '12px', color: 'var(--text-primary)', margin: '14px 0 6px' },
  6: { fontSize: '12px', color: 'var(--text-muted)', margin: '14px 0 6px' },
};

/**
 * @param {object} props
 * @param {string} props.markdown
 * @param {(src:string)=>string} [props.resolveImage] maps an image path as
 *   written in the markdown (e.g. "images/manual/x.jpg") to a URL the app
 *   can load — bundled asset, served file, or a GitHub raw URL.
 */
export const MarkdownView = ({ markdown, resolveImage }) => {
  const rootRef = useRef(null);

  const renderImage = useCallback(
    (alt, src, key) => {
      const url = resolveImage ? resolveImage(src) : src;
      return (
        <img
          key={key}
          src={url}
          alt={alt}
          loading="lazy"
          style={{
            display: 'block',
            maxWidth: '100%',
            height: 'auto',
            margin: '4px 0',
            borderRadius: '6px',
            border: '1px solid var(--border-color)',
          }}
        />
      );
    },
    [resolveImage],
  );

  const scrollToAnchor = useCallback((id) => {
    const root = rootRef.current;
    if (!root || !id) return;
    let el = null;
    try {
      el = root.querySelector(`#${CSS.escape(id)}`);
    } catch {
      el = null;
    }
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const renderLink = useCallback(
    (label, href, key) => {
      const style = { color: 'var(--accent-cyan)', textDecoration: 'underline' };
      if (href.startsWith('#')) {
        const id = href.slice(1);
        return (
          <a
            key={key}
            href={href}
            style={style}
            onClick={(e) => {
              e.preventDefault();
              scrollToAnchor(id);
            }}
          >
            {parseInline(label, `${key}-l`, (t2, h2, k2) => (
              <span key={k2}>{t2}</span>
            ))}
          </a>
        );
      }
      const external = /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
      const url = external ? href : resolveRelativeHref(href);
      return (
        <a key={key} href={url} target="_blank" rel="noopener noreferrer" style={style}>
          {parseInline(label, `${key}-l`, (t2, h2, k2) => (
            <span key={k2}>{t2}</span>
          ))}
        </a>
      );
    },
    [scrollToAnchor],
  );

  const blocks = useMemo(() => parseBlocks(markdown), [markdown]);

  const rendered = useMemo(() => {
    const slugger = createSlugger();
    return blocks.map((block, bi) => {
      const key = `b${bi}`;
      switch (block.type) {
        case 'heading': {
          const text = stripInlineMarkdown(block.text);
          const id = slugger(text);
          const Tag = `h${block.level}`;
          return (
            <Tag key={key} id={id} style={{ ...headingStyles[block.level], scrollMarginTop: '8px' }}>
              {parseInline(block.text, key, renderLink, renderImage)}
            </Tag>
          );
        }
        case 'paragraph':
          return (
            <p key={key} style={{ lineHeight: 1.6, margin: '0 0 12px', color: 'var(--text-secondary)' }}>
              {parseInline(block.text, key, renderLink, renderImage)}
            </p>
          );
        case 'hr':
          return (
            <hr key={key} style={{ border: 'none', borderTop: '1px solid var(--border-color)', margin: '24px 0' }} />
          );
        case 'blockquote':
          return (
            <blockquote
              key={key}
              style={{
                borderLeft: '3px solid var(--accent-amber)',
                margin: '0 0 12px',
                padding: '4px 0 4px 12px',
                color: 'var(--text-muted)',
              }}
            >
              {parseInline(block.text, key, renderLink, renderImage)}
            </blockquote>
          );
        case 'codeblock':
          return (
            <pre
              key={key}
              style={{
                background: 'var(--bg-tertiary)',
                border: '1px solid var(--border-color)',
                borderRadius: '6px',
                padding: '12px',
                overflowX: 'auto',
                fontFamily: 'var(--font-mono)',
                fontSize: '12px',
                lineHeight: 1.5,
                margin: '0 0 12px',
              }}
            >
              <code>{block.code}</code>
            </pre>
          );
        case 'list': {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag key={key} style={{ margin: '0 0 12px', paddingLeft: '24px', color: 'var(--text-secondary)' }}>
              {block.items.map((item, ii) => (
                <li key={`${key}-${ii}`} style={{ marginBottom: '6px', lineHeight: 1.55 }}>
                  {parseInline(item.text, `${key}-${ii}`, renderLink, renderImage)}
                  {item.children.length > 0 && (
                    <ul style={{ margin: '6px 0 0', paddingLeft: '20px' }}>
                      {item.children.map((child, ci) => (
                        <li key={`${key}-${ii}-${ci}`} style={{ marginBottom: '4px' }}>
                          {parseInline(child, `${key}-${ii}-${ci}`, renderLink, renderImage)}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ListTag>
          );
        }
        case 'table':
          return (
            <div key={key} style={{ overflowX: 'auto', margin: '0 0 16px' }}>
              <table style={{ borderCollapse: 'collapse', fontSize: '12px', minWidth: '50%' }}>
                <thead>
                  <tr>
                    {block.header.map((cell, ci) => (
                      <th
                        key={`${key}-h${ci}`}
                        style={{
                          textAlign: 'left',
                          padding: '6px 10px',
                          borderBottom: '2px solid var(--border-color)',
                          color: 'var(--accent-amber)',
                          fontFamily: 'var(--font-mono)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {parseInline(cell, `${key}-h${ci}`, renderLink, renderImage)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, ri) => (
                    <tr key={`${key}-r${ri}`}>
                      {row.map((cell, ci) => (
                        <td
                          key={`${key}-r${ri}-${ci}`}
                          style={{
                            padding: '6px 10px',
                            borderBottom: '1px solid var(--border-color)',
                            color: 'var(--text-secondary)',
                            lineHeight: 1.5,
                            verticalAlign: 'top',
                          }}
                        >
                          {parseInline(cell, `${key}-r${ri}-${ci}`, renderLink, renderImage)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        case 'gallery':
          return (
            <div
              key={key}
              style={{
                display: 'grid',
                gridTemplateColumns: `repeat(${block.cols}, minmax(0, 1fr))`,
                gap: '10px',
                margin: '0 0 16px',
              }}
            >
              {block.items.map((it, ii) => (
                <figure key={`${key}-${ii}`} style={{ margin: 0, minWidth: 0 }}>
                  {renderImage(it.alt, it.src, `${key}-${ii}-img`)}
                  {it.caption && (
                    <figcaption style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                      {it.caption}
                    </figcaption>
                  )}
                </figure>
              ))}
            </div>
          );
        default:
          return null;
      }
    });
  }, [blocks, renderLink, renderImage]);

  return (
    <div ref={rootRef} style={{ fontSize: '13px', minWidth: 0 }}>
      {rendered}
    </div>
  );
};

export default MarkdownView;
