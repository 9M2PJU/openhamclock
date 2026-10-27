/**
 * MarkdownView parser — images and screenshot galleries (the manual's
 * in-app rendering showed broken links once docs/MANUAL.md gained images).
 */
import { describe, it, expect } from 'vitest';
import { parseBlocks, parseInline, stripInlineMarkdown } from './MarkdownView.jsx';

const link = (label, href, key) => ({ kind: 'link', label, href, key });
const image = (alt, src, key) => ({ kind: 'img', alt, src, key });

describe('parseInline images', () => {
  it('renders ![alt](src) through the image renderer, not as a link', () => {
    const nodes = parseInline('See ![The map](images/manual/map-flat.jpg) here', 'k', link, image);
    const img = nodes.find((n) => n && n.kind === 'img');
    expect(img).toEqual({ kind: 'img', alt: 'The map', src: 'images/manual/map-flat.jpg', key: 'k-0' });
    expect(nodes.some((n) => n && n.kind === 'link')).toBe(false);
    expect(nodes[0]).toBe('See ');
  });
  it('still renders ordinary links and an empty alt', () => {
    const nodes = parseInline('[docs](API.md) ![](x.jpg)', 'k', link, image);
    expect(nodes.filter((n) => n && n.kind === 'link')).toHaveLength(1);
    expect(nodes.find((n) => n && n.kind === 'img').alt).toBe('');
  });
  it('strips images from plain-text (TOC) rendering', () => {
    expect(stripInlineMarkdown('Intro ![shot](a.jpg) done')).toBe('Intro shot done');
  });
});

describe('parseBlocks galleries', () => {
  const md = [
    'Text before.',
    '',
    '<table>',
    '<tr><td width="50%" valign="top"><img src="images/manual/layout-modern.jpg" alt="Modern"><br><sub>Modern</sub></td><td width="50%" valign="top"><img src="images/manual/layout-classic.jpg" alt="Classic"><br><sub>Classic</sub></td></tr>',
    '<tr><td width="50%" valign="top"><img src="images/manual/layout-tablet.jpg" alt="Tablet"><br><sub>Tablet</sub></td></tr>',
    '</table>',
    '',
    'Text after.',
  ].join('\n');
  it('turns the HTML table of screenshots into a gallery block with the right column count', () => {
    const blocks = parseBlocks(md);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'gallery', 'paragraph']);
    const g = blocks[1];
    expect(g.cols).toBe(2);
    expect(g.items).toEqual([
      { src: 'images/manual/layout-modern.jpg', alt: 'Modern', caption: 'Modern' },
      { src: 'images/manual/layout-classic.jpg', alt: 'Classic', caption: 'Classic' },
      { src: 'images/manual/layout-tablet.jpg', alt: 'Tablet', caption: 'Tablet' },
    ]);
  });
  it('does not swallow a gallery into the preceding paragraph', () => {
    const blocks = parseBlocks('Line one\n<table>\n<tr><td><img src="a.jpg" alt="A"></td></tr>\n</table>');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'gallery']);
    expect(blocks[0].text).toBe('Line one');
  });
  it('keeps a lone image paragraph as a paragraph (rendered as a figure by the view)', () => {
    const blocks = parseBlocks('![Shot](images/manual/x.jpg)\n\n_Caption_');
    expect(blocks[0].type).toBe('paragraph');
    expect(blocks[0].text).toBe('![Shot](images/manual/x.jpg)');
  });
});
