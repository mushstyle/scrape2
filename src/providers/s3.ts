// Import AWS SDK v3 modules
import { S3Client } from '@aws-sdk/client-s3';
import {
  HeadObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import crypto from "crypto";
import { logger } from '../lib/logger.js';

const log = logger.createContext('s3');

// Helper function to trim quotes from environment variables
const trimQuotes = (value: string | undefined): string | undefined => {
  return value ? value.replace(/^['"]|['"]$/g, '') : undefined;
};

// Trim environment variables
const awsRegion = trimQuotes(process.env.AWS_REGION);
const awsAccessKeyId = trimQuotes(process.env.AWS_ACCESS_KEY_ID);
const awsSecretAccessKey = trimQuotes(process.env.AWS_SECRET_ACCESS_KEY);
const s3BucketName = trimQuotes(process.env.S3_CLOTHES_DB_BUCKET) || 'clothes-db';

const S3_CLOTHES_DB_BUCKET = s3BucketName;

// Global counter for cache hits
let s3CacheHits = 0;
export const getS3CacheHits = () => s3CacheHits;
export const resetS3CacheHits = () => { s3CacheHits = 0; };

// Initialize AWS SDK v3 client using trimmed variables
const s3Client = new S3Client({
  region: awsRegion,
  credentials: {
    accessKeyId: awsAccessKeyId || '',
    secretAccessKey: awsSecretAccessKey || ''
  }
});

export interface S3File {
  buffer: Buffer;
  mimetype: string;
}

/**
 * Generate a hash for a string
 * @param strToHash String to hash
 * @returns Hex hash string
 */
export const hashString = (strToHash: string): string => {
  const hash = crypto.createHash("sha256");
  hash.update(strToHash);
  return hash.digest("hex");
};

/**
 * Convert an image URL to a buffer
 * @param imageUrl URL of the image to fetch
 * @returns Buffer containing the image data
 */
export const imageUrlToBuffer = async (imageUrl: string): Promise<Buffer> => {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

/**
 * Check if an object exists in S3 and return its URL if it does
 * @param bucket S3 bucket name
 * @param filename Object key in S3
 * @returns URL of the object if it exists, null otherwise
 */
export const getS3ObjectUrl = async (bucket: string, filename: string): Promise<string | null> => {
  const params = {
    Bucket: bucket,
    Key: filename
  };
  try {
    await s3Client.send(new HeadObjectCommand(params));
    // Use the potentially trimmed awsRegion here as well
    return `https://${bucket}.s3.${awsRegion}.amazonaws.com/${filename}`;
  } catch (_) {
    return null;
  }
};

/**
 * Upload a file to an S3 bucket
 * @param bucket S3 bucket name
 * @param file File object with buffer and mimetype
 * @param useCache Whether to check if file already exists before uploading
 * @returns URL of the uploaded file
 */
export const uploadToS3Bucket = async (
  bucket: string,
  file: S3File,
  useCache: boolean = true
): Promise<string> => {
  const imageBuffer = file.buffer;
  const base64 = Buffer.from(imageBuffer).toString("base64");
  const hash = hashString(base64);
  const fileExtension = file.mimetype.split("/")[1] || 'jpg'; // Default to jpg if mimetype is weird
  const filename = `${hash}.${fileExtension}`;

  // First check if file exists if caching is enabled
  if (useCache) {
    const location = await getS3ObjectUrl(bucket, filename);
    if (location) {
      log.debug("S3 cache hit", { filename });
      s3CacheHits++;
      return location;
    }
  }

  try {
    // Delete any existing file with same name if not using cache
    if (!useCache) {
      try {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: bucket,
          Key: filename
        }));
      } catch (_) {
        // Ignore error if file doesn't exist
      }
    }

    // If file doesn't exist or cache is disabled, upload it
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: bucket,
        Key: filename,
        Body: imageBuffer,
        ContentType: file.mimetype,
        ACL: "public-read"
      }
    });

    await upload.done(); // Wait for upload to complete
    // Use the potentially trimmed awsRegion here as well
    return `https://${bucket}.s3.${awsRegion}.amazonaws.com/${filename}`;
  } catch (err) {
    log.error("Error uploading to S3", { err });
    throw err;
  }
};

/**
 * Upload a file to the clothes-db bucket
 * @param file File object with buffer and mimetype
 * @param useCache Whether to check if file already exists before uploading
 * @returns URL of the uploaded file
 */
export const uploadToClothesDB = async (file: S3File, useCache: boolean = true): Promise<string> =>
  uploadToS3Bucket(S3_CLOTHES_DB_BUCKET, file, useCache);

/**
 * Convert a URL to a file object and upload it to S3
 * @param imageUrl URL of the image to upload
 * @param mimeType Optional MIME type, defaults to jpeg
 * @param useCache Whether to check if file already exists before uploading
 * @returns URL of the uploaded file
 */
export const uploadImageUrlToS3 = async (
  imageUrl: string,
  mimeType: string = "image/jpeg",
  useCache: boolean = true
): Promise<string> => {
  const buffer = await imageUrlToBuffer(imageUrl);

  const file: S3File = {
    buffer,
    mimetype: mimeType
  };

  return uploadToClothesDB(file, useCache);
};

/**
 * Delete an object from an S3 bucket
 * @param bucket S3 bucket name
 * @param filename Object key in S3
 */
export const deleteFromS3Bucket = async (bucket: string, filename: string): Promise<void> => {
  const params = {
    Bucket: bucket,
    Key: filename
  };

  try {
    await s3Client.send(new DeleteObjectCommand(params));
    log.normal("Successfully deleted file from S3", { bucket, filename });
  } catch (err) {
    log.error("Error deleting from S3", { err, bucket, filename });
    throw err;
  }
};

/**
 * Delete an object from the clothes-db bucket
 * @param filename Object key in S3
 */
export const deleteFromClothesDB = async (filename: string): Promise<void> =>
  deleteFromS3Bucket(S3_CLOTHES_DB_BUCKET, filename);

/**
 * Generate a mush URL from an image URL
 * @param imageUrl Original image URL
 * @returns Mush URL for the image
 */
export const generateMushUrl = (imageUrl: string): string => {
  const hash = hashString(imageUrl);
  return `${hash}.jpg`;
};

/**
 * Generate a mush URL for a no-background version
 * @param mushUrl Original mush URL
 * @returns No-background version of the mush URL
 */
export const generateMushUrlNoBg = (mushUrl: string): string => {
  const extension = mushUrl.split('.').pop() || 'jpg';
  const basename = mushUrl.replace(`.${extension}`, '');
  return `${basename}-nobg.${extension}`;
};

/**
 * Upload image buffer to S3 with a specific key
 * @param buffer Image buffer to upload
 * @param key S3 key (filename)
 * @param mimeType Optional MIME type, defaults to jpeg
 * @returns URL of the uploaded file
 */
export const uploadImageToS3 = async (
  buffer: Buffer,
  key: string,
  mimeType: string = "image/jpeg"
): Promise<string> => {
  try {
    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: S3_CLOTHES_DB_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
        ACL: "public-read"
      }
    });

    await upload.done();
    // Use the potentially trimmed awsRegion here as well
    return `https://${S3_CLOTHES_DB_BUCKET}.s3.${awsRegion}.amazonaws.com/${key}`;
  } catch (err) {
    log.error("Error uploading to S3", { err });
    throw err;
  }
}; 