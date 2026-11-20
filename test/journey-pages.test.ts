import { describe, it, expect } from 'vitest';
import { pickJourneyPages } from '../src/collect/browser/evaluation/journey.js';

describe('journey page discovery', () => {
  const home = 'https://shop.test/';
  it('picks a real product over the gift card (walrusaudio.com, 2026-11)', () => {
    const links = ['https://shop.test/products/gift-card', 'https://shop.test/products/lore-mkii', 'https://shop.test/collections/all', 'https://shop.test/cart'];
    expect(pickJourneyPages(links, home, 3)).toEqual(['https://shop.test/collections/all', 'https://shop.test/products/lore-mkii', 'https://shop.test/cart']);
  });
  it('falls back to the gift card when it is the only product link', () => {
    expect(pickJourneyPages(['https://shop.test/products/gift-card', 'https://shop.test/cart'], home, 3)).toEqual(['https://shop.test/products/gift-card', 'https://shop.test/cart']);
  });
  it('keeps other hosts, the current page and never-visit links out', () => {
    expect(pickJourneyPages(['https://other.test/products/x', 'https://shop.test/', 'https://shop.test/account/login', 'https://shop.test/products/x'], home, 3)).toEqual(['https://shop.test/products/x']);
  });
});
