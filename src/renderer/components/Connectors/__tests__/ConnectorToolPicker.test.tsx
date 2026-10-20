// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import ConnectorToolPicker from '../ConnectorToolPicker';
import { en } from '../../../i18n/locales/en';
vi.mock('../../../hooks/useT', () => ({ useT: () => (key: keyof typeof en) => en[key] ?? key }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
afterEach(() => { act(() => root.unmount()); host.remove(); });
it('does not grant tools on discovery or checkbox changes; review contains only selected names', async () => {
  const review = vi.fn(); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ConnectorToolPicker names={['gmail.search_threads', 'gmail.create_draft', 'bad/name']} policy={{ mode: 'listed', allowed: [] }} disabled={false} onReview={review} />));
  const boxes = host.querySelectorAll<HTMLInputElement>('input');
  expect(boxes).toHaveLength(2);
  expect([...boxes].every((box) => !box.checked)).toBe(true);
  await act(async () => boxes[0].click());
  expect(review).not.toHaveBeenCalled();
  await act(async () => host.querySelector('button')!.click());
  expect(review).toHaveBeenCalledWith({ mode: 'listed', allowed: ['gmail.search_threads'] });
});
