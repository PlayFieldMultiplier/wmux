// Which view a file a bot attached gets in the side panel, and the text the
// panel draws.
import { describe, expect, it } from 'vitest';
import { FILE_TEXT_SHOWN_MAX, fileGlyph, fileViewKind, htmlPreviewable, shownText, svgImageSource } from '../botsFileView';

const kind = (name: string, mediaType = 'application/octet-stream') => fileViewKind({ name, mediaType });

describe('fileViewKind', () => {
  it('reads the media type first, the extension when the type is generic', () => {
    expect(kind('report.md', 'text/markdown')).toBe('markdown');
    expect(kind('NOTES.markdown')).toBe('markdown');
    expect(kind('data.json', 'application/json')).toBe('text');
    expect(kind('rows.csv', 'text/csv')).toBe('text');
    expect(kind('main.rs')).toBe('text');
    expect(kind('a.txt', 'text/plain; charset=utf-8')).toBe('text');
    expect(kind('shot.png', 'image/png')).toBe('image');
    expect(kind('shot.webp')).toBe('image');
    expect(kind('logo.svg', 'image/svg+xml')).toBe('svg');
    expect(kind('paper.pdf', 'application/pdf')).toBe('other');
    expect(kind('page.html', 'text/html')).toBe('html');
    expect(kind('build.zip', 'application/zip')).toBe('other');
    expect(kind('blob.bin')).toBe('other');
  });
});

describe('an HTML page', () => {
  it('is its own kind by type (text/html, application/xhtml+xml) or by extension (.html, .htm)', () => {
    expect(kind('page.html', 'text/html')).toBe('html');
    expect(kind('page', 'text/html; charset=utf-8')).toBe('html');
    expect(kind('page.xhtml', 'application/xhtml+xml')).toBe('html');
    expect(kind('index.htm')).toBe('html');
    expect(kind('REPORT.HTML', 'text/plain')).toBe('html');
    expect(kind('notes.xml', 'application/xml')).toBe('text');
    expect(fileGlyph('html')).toBe('file');
  });

  it('shows rendered up to the panel text size, past it as its source only', () => {
    expect(htmlPreviewable('x'.repeat(FILE_TEXT_SHOWN_MAX))).toBe(true);
    expect(htmlPreviewable('x'.repeat(FILE_TEXT_SHOWN_MAX + 1))).toBe(false);
  });
});

describe('the panel text', () => {
  it('cuts text past the shown limit and says it did', () => {
    expect(shownText('abc')).toEqual({ text: 'abc', cut: false });
    const long = shownText('x'.repeat(FILE_TEXT_SHOWN_MAX + 5));
    expect(long.cut).toBe(true);
    expect(long.text.length).toBe(FILE_TEXT_SHOWN_MAX);
  });

  it('an SVG becomes an image source, never markup in the page', () => {
    expect(svgImageSource({ text: '<svg onload="x()"/>' })).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg onload="x()"/>')}`);
    expect(svgImageSource({})).toBeNull();
  });

  it('a cut text says how many bytes it shows', () => {
    const cut = shownText('한'.repeat(FILE_TEXT_SHOWN_MAX + 1));
    expect(cut.shownBytes).toBe(FILE_TEXT_SHOWN_MAX * 3);
  });
});
