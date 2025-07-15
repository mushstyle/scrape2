import type { Image } from '../types/item.js';
import { uploadImageUrlToS3 } from '../providers/s3.js';
import { logger } from './logger.js';

const log = logger.createContext('image-utils');

/**
 * Takes an array of Image objects, uploads each image URL to S3 in parallel,
 * and returns a new array with the `mushUrl` property added to each successfully uploaded image.
 * Logs errors ONLY for failed uploads but does not throw.
 *
 * @param images - The array of original Image objects. Can be undefined or empty.
 * @param sourceUrl - The source URL of the item, used for logging context.
 * @returns A promise that resolves to a new array of Image objects, potentially including mushUrls.
 */
export async function uploadImagesToS3AndAddUrls(
  images: Image[] | undefined,
  sourceUrl: string
): Promise<Image[]> {
  if (!images || images.length === 0) {
    return []; // Return empty array if no images provided
  }

  const imagesWithMushUrlPromises = images.map(async (image) => {
    // Ensure image object and sourceUrl property are valid before proceeding
    if (!image || typeof image !== 'object' || typeof image.sourceUrl !== 'string' || !image.sourceUrl) {
      log.error(`Skipping image upload for invalid image object or missing sourceUrl (source: ${sourceUrl}):`, image);
      // Return a shallow copy to avoid modifying the original input array directly
      return { ...image };
    }

    try {
      log.debug(`Uploading image to S3 for ${sourceUrl}: ${image.sourceUrl}`);
      const mushUrl = await uploadImageUrlToS3(image.sourceUrl);
      log.debug(`Successfully uploaded image. S3 URL: ${mushUrl}`);
      // Return a new object with the mushUrl included
      return { ...image, mushUrl: mushUrl };
    } catch (error) {
      log.error(`Failed to upload image ${image.sourceUrl} from ${sourceUrl} to S3:`, error);
      // Return a shallow copy of the original image object on error
      return { ...image };
    }
  });

  // Wait for all upload promises to settle
  const processedImages = await Promise.all(imagesWithMushUrlPromises);

  // Filter out any potentially undefined/null results if map logic could produce them (though current logic doesn't)
  return processedImages.filter((img): img is Image => img !== null && img !== undefined);
} 