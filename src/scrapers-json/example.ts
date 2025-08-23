import type { JsonScraper } from '../types/json-scraper.js';
import type { Item, Image, Size } from '../types/item.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('example.com-json');

const scraper: JsonScraper = {
  domain: 'example.com',
  
  async scrapeItem(json: unknown, options?: { uploadToS3?: boolean }): Promise<Item> {
    const uploadToS3 = options?.uploadToS3 ?? true;
    const data = json as any;
    
    // Extract images with correct field names for Image type
    const images: Image[] = (data.images || []).map((img: any) => ({
      sourceUrl: typeof img === 'string' ? img : (img.url || img.sourceUrl || ''),
      alt_text: img.alt || img.alt_text || data.name || 'Product image'
    }));
    
    // Handle S3 upload if enabled
    let finalImages = images;
    const productUrl = data.url || data.link || '';
    if (uploadToS3 && images.length > 0) {
      log.debug(`Uploading ${images.length} images to S3...`);
      finalImages = await uploadImagesToS3AndAddUrls(images, productUrl);
      log.debug(`S3 upload complete`);
    }
    
    // Extract sizes with correct field names
    const sizes: Size[] | undefined = data.sizes ? data.sizes.map((s: any) => ({
      size: s.size || s.name || s,
      is_available: s.is_available !== undefined ? s.is_available : true
    })) : undefined;
    
    return {
      sourceUrl: productUrl,
      product_id: data.id || data.sku || 'unknown',
      title: data.name || data.title || 'Unknown Product',
      description: data.description || undefined,
      vendor: data.brand || undefined,
      type: data.category || undefined,
      tags: data.tags || undefined,
      images: finalImages,
      rating: data.rating || undefined,
      num_ratings: data.num_ratings || undefined,
      color: data.color || undefined,
      sizes: sizes,
      variants: undefined,
      price: data.originalPrice || data.price || 0,
      sale_price: data.salePrice || (data.currentPrice < data.price ? data.currentPrice : undefined),
      currency: data.currency || 'USD',
      similar_item_urls: undefined,
      status: 'ACTIVE'
    };
  }
};

export default scraper;