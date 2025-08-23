import type { JsonScraper } from './types.js';
import type { Item, Image, Size } from '../types/item.js';

const scraper: JsonScraper = {
  domain: 'diesel.com',
  
  scrapeItem(json: unknown): Item {
    const data = json as any;
    const product = data?.data?.product;
    
    if (!product) {
      throw new Error('Invalid Diesel JSON structure - missing product data');
    }
    
    // Extract images
    const images: Image[] = [];
    if (product.images?.large) {
      product.images.large.forEach((img: any) => {
        if (img.absURL) {
          images.push({
            url: img.absURL,
            alt: img.alt || product.productName
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
          name: size.displayValue || size.value,
          inStock: size.selectable !== false,
          price: product.price?.sales?.value
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
    
    return {
      id: product.id || product.uuid || 'unknown',
      name: product.productName || product.productNameForTile || 'Unknown Product',
      url: productUrl,
      currency: currency,
      currentPrice: currentPrice,
      originalPrice: originalPrice,
      images: images,
      sizes: sizes,
      inStock: product.available !== false && product.availability?.isStock !== false,
      description: product.longDescription || product.shortDescription || '',
      brand: product.brand || 'Diesel',
      category: product.category?.name || '',
      metadata: {
        productType: product.productType,
        masterID: product.masterID,
        gender: product.gender,
        genderCode: product.genderCode,
        editorialComposition: product.editorialComposition,
        rating: product.rating
      }
    };
  }
};

export default scraper;