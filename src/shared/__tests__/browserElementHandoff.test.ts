import { describe, it, expect } from 'vitest';
import { formatElementHandoff, parseInspectedElement } from '../browserElementHandoff';

const base = {
  title: 'Checkout',
  url: 'https://shop.example/cart',
  selector: 'button.pay',
  tag: '<button type="submit">',
  text: 'Pay now',
};

describe('parseInspectedElement', () => {
  it('rejects anything without a selector', () => {
    expect(parseInspectedElement(null)).toBeNull();
    expect(parseInspectedElement('button.pay')).toBeNull();
    expect(parseInspectedElement({ ...base, selector: '' })).toBeNull();
    expect(parseInspectedElement({ ...base, selector: 42 })).toBeNull();
  });

  it('strips terminal control sequences the page put in its text', () => {
    // A bracketed-paste close followed by a command, an OSC 52 clipboard
    // write and a bare CR: none of them may reach the terminal.
    const el = parseInspectedElement({
      ...base,
      text: 'Pay\x1b[201~rm -rf ~\r\x1b]52;c;ZXZpbA==\x07 now\x00',
    });
    expect(el?.text).toBe('Payrm -rf ~ now');
    // eslint-disable-next-line no-control-regex -- asserting the controls are gone
    expect(el?.text).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  it('collapses every field to one line and caps its length', () => {
    const el = parseInspectedElement({ ...base, text: `line one\nline two\n\n${'x'.repeat(500)}` });
    expect(el?.text).not.toContain('\n');
    expect(el?.text.startsWith('line one line two x')).toBe(true);
    expect(el?.text.length).toBe(200);
    expect(el?.text.endsWith('…')).toBe(true);
  });
});

describe('formatElementHandoff', () => {
  it('puts the note first and the element after it, on one line', () => {
    const el = parseInspectedElement(base);
    if (!el) throw new Error('parse failed');
    expect(formatElementHandoff(el, 'make this green\nplease')).toBe(
      'make this green please ([browser element] Checkout — https://shop.example/cart · selector: button.pay · <button type="submit"> · text: "Pay now")',
    );
  });

  it('without a note it is the element alone, and empty fields drop out', () => {
    const el = parseInspectedElement({ selector: '#total' });
    if (!el) throw new Error('parse failed');
    expect(formatElementHandoff(el, '   ')).toBe('[browser element] · selector: #total');
  });
});
