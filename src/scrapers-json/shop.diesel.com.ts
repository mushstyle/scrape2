import type { JsonScraper } from '../types/json-scraper.js';
import type { Item, Image, Size } from '../types/item.js';
import { uploadImagesToS3AndAddUrls } from '../utils/image-utils.js';
import { logger } from '../utils/logger.js';

const log = logger.createContext('diesel.com-json');

const scraper: JsonScraper = {
  domain: 'shop.diesel.com',
  
  async scrapeItem(json: unknown, options?: { uploadToS3?: boolean }): Promise<Item> {
    const uploadToS3 = options?.uploadToS3 ?? true;
    const data = json as any;
    const product = data?.data?.product;
    
    if (!product) {
      throw new Error('Invalid Diesel JSON structure - missing product data');
    }
    
    // Extract images with correct field names for Image type
    const images: Image[] = [];
    if (product.images?.large) {
      product.images.large.forEach((img: any) => {
        if (img.absURL) {
          images.push({
            sourceUrl: img.absURL,
            alt_text: img.alt || product.productName
          });
        }
      });
    }
    
    // Extract sizes
    const sizes: Size[] = [];
    const sizeAttribute = product.variationAttributes?.find((attr: any) => 
      attr.attributeId === 'size' || attr.id === 'size'
    );
    
    if (sizeAttribute?.values) {
      sizeAttribute.values.forEach((size: any) => {
        sizes.push({
          size: size.displayValue || size.value,
          is_available: size.selectable !== false
        });
      });
    }
    
    // Extract price info
    const currentPrice = product.price?.sales?.value || 0;
    const originalPrice = product.price?.list?.value || currentPrice;
    const currency = product.price?.sales?.currency || 'USD';
    
    // Build full URL
    const baseUrl = 'https://shop.diesel.com';
    const productUrl = product.selectedProductUrl 
      ? baseUrl + product.selectedProductUrl
      : data.url || '';
    
    // Handle S3 upload if enabled
    let finalImages = images;
    if (uploadToS3 && images.length > 0) {
      log.debug(`Uploading ${images.length} images to S3...`);
      finalImages = await uploadImagesToS3AndAddUrls(images, productUrl);
      log.debug(`S3 upload complete, images have mushUrl property`);
    }
    
    return {
      sourceUrl: productUrl,
      product_id: product.id || product.uuid || 'unknown',
      title: product.productName || product.productNameForTile || 'Unknown Product',
      description: product.longDescription || product.shortDescription || undefined,
      vendor: product.brand || 'Diesel',
      type: product.category?.name || undefined,
      tags: product.tags || undefined,
      images: finalImages,
      rating: product.rating || undefined,
      num_ratings: undefined,
      color: product.selectedColor?.displayValue || undefined,
      sizes: sizes.length > 0 ? sizes : undefined,
      variants: undefined,
      price: originalPrice,
      sale_price: currentPrice < originalPrice ? currentPrice : undefined,
      currency: currency,
      similar_item_urls: undefined,
      status: 'ACTIVE'
    };
  }
};

export default scraper;