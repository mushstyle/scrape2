import { Item } from './types.js';
import { createHash } from 'crypto';

const currencyMap = {
  '$': 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'CNY',
  '₹': 'INR',
  '₩': 'KRW',
  '₽': 'RUB',
  '₺': 'TRY',
  '₴': 'UAH',
}

export const DEFAULT_IMAGE_WIDTH = 600;

export const scrapeDate = () => {
  return new Date().toISOString().split('T')[0];
};

export const mkItemId = (item: Item) => {
  // Strip trailing slash from sourceUrl if present
  const url = item.sourceUrl.endsWith('/') ? item.sourceUrl.slice(0, -1) : item.sourceUrl;
  return createHash('sha256').update(url).digest('hex');
};

export const formatItem = (item: Item): Item => {
  item.currency = currencyMap[item.currency as keyof typeof currencyMap] || item.currency;
  item.images = item.images.map(image => ({
    ...image,
    sourceUrl: image.sourceUrl.startsWith('//') ? `https:${image.sourceUrl}` : image.sourceUrl
  }));
  return item;
};
