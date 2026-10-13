import { describe, expect, it } from 'vitest';
import { formatPreviewBytes, isPreviewablePath, looksComplete, previewTypeOf, previewUrl } from '../filePreview';

describe('file preview types (#2150)', () => {
  it('opens images and PDFs as previews, by extension and case-insensitively', () => {
    expect(previewTypeOf('/repo/out/Plot.PNG')).toEqual({ kind: 'image', mime: 'image/png' });
    expect(previewTypeOf('C:\\repo\\report.pdf')).toEqual({ kind: 'pdf', mime: 'application/pdf' });
    expect(isPreviewablePath('/repo/icon.svg')).toBe(true);
  });

  it('leaves text, extensionless files and dotfiles to the editor', () => {
    for (const p of ['/repo/a.ts', '/repo/Makefile', '/repo/.png', '/repo/png', 'C:\\repo\\dir.pdf\\notes.txt']) {
      expect(isPreviewablePath(p)).toBe(false);
    }
  });

  it('puts only the token and the encoded file name in the URL', () => {
    expect(previewUrl('ab'.repeat(16), '/home/me/out/my plot.png', 3))
      .toBe(`wmux-preview://${'ab'.repeat(16)}/my%20plot.png?v=3`);
  });

  it('formats sizes the way the footer shows them', () => {
    expect(formatPreviewBytes(512)).toBe('512 B');
    expect(formatPreviewBytes(240 * 1024)).toBe('240 KB');
    expect(formatPreviewBytes(1.4 * 1024 * 1024)).toBe('1.4 MB');
  });

  it('tells a finished file from one a writer stopped part-way through', () => {
    const iend = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
    expect(looksComplete('a.png', Uint8Array.from(iend))).toBe(true);
    expect(looksComplete('a.png', Uint8Array.from(iend.slice(0, 9)))).toBe(false);
    expect(looksComplete('a.jpg', Uint8Array.from([1, 2, 0xff, 0xd9, 0, 0]))).toBe(true);
    expect(looksComplete('a.jpg', Uint8Array.from([1, 2, 0xff, 0xd8]))).toBe(false);
    expect(looksComplete('a.pdf', new TextEncoder().encode('trailer\nstartxref\n9\n%%EOF\n'))).toBe(true);
    expect(looksComplete('a.pdf', new TextEncoder().encode('1 0 obj << /Type'))).toBe(false);
    expect(looksComplete('a.webp', Uint8Array.from([1]))).toBe(true);
    expect(looksComplete('a.png', new Uint8Array())).toBe(false);
  });
});
