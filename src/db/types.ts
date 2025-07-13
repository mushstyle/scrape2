import { z } from 'zod';

export const ImageSchema = z.object({
  sourceUrl: z.string(),
  alt_text: z.string().optional(),
  mushUrl: z.string().optional(),
});

export type Image = z.infer<typeof ImageSchema>;

export const SizeSchema = z.object({
  size: z.string(),
  is_available: z.boolean(),
});

export type Size = z.infer<typeof SizeSchema>;

export const ItemSchema = z.object({
  sourceUrl: z.string(),
  product_id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  vendor: z.string().optional(),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  images: z.array(ImageSchema),
  rating: z.number().optional(),
  num_ratings: z.number().optional(),
  color: z.string().optional(),
  sizes: z.array(SizeSchema).optional(),
  variants: z.array(z.object({
    name: z.string(),
    url: z.string().nullable(),
  })).optional(),
  price: z.number(),
  sale_price: z.number().optional(),
  currency: z.string().optional(),
  similar_item_urls: z.array(z.string()).optional(),
  status: z.enum(['ACTIVE', 'DELETED']).optional(),
});

export type Item = z.infer<typeof ItemSchema>;

export const ItemDbEntrySchema = z.object({
  domain: z.string(),
  last_scraped_at: z.string(),
  item: ItemSchema,
});

export type ItemDbEntry = z.infer<typeof ItemDbEntrySchema>;

export const ItemDbSchema = z.record(z.string(), ItemDbEntrySchema);

export type ItemDb = z.infer<typeof ItemDbSchema>;

export const StartPageSchema = z.object({
  label: z.string(),
  url: z.string(),
});

export type StartPage = z.infer<typeof StartPageSchema>;

export const SiteScrapingConfigSchema = z.object({
  browser: z.object({
    headless: z.boolean().optional(),
    userAgent: z.string().optional(),
    ignoreHttpsErrors: z.boolean().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    args: z.array(z.string()).optional(),
    viewport: z.object({
      width: z.number(),
      height: z.number(),
    }).nullable().optional(),
  }),
});

export type SiteScrapingConfig = z.infer<typeof SiteScrapingConfigSchema>;

export const SiteSchema = z.object({
  domain: z.string(),
  scraper: z.string(),
  startPages: z.array(StartPageSchema),
  scraping: SiteScrapingConfigSchema.optional(),
});

export type Site = z.infer<typeof SiteSchema>;

export const SiteDbSchema = z.object({
  sites: z.array(SiteSchema),
});

export type SiteDb = z.infer<typeof SiteDbSchema>;