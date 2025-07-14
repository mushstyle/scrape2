import type { Page } from 'playwright';

export interface CacheOptions {
  maxSizeBytes: number; // Default: 100MB
  ttlSeconds?: number; // Optional TTL
}

export interface CacheStats {
  hits: number;
  misses: number;
  sizeBytes: number;
  itemCount: number;
}

export interface CacheEntry {
  url: string;
  response: Buffer;
  headers: Record<string, string>;
  status: number;
  timestamp: number;
  size: number;
}