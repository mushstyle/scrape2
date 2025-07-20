import { describe, it, expect, vi } from 'vitest';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get the directory of this test file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mock playwright Page
vi.mock('playwright', () => ({
  Page: class MockPage {},
  Browser: class MockBrowser {},
  BrowserContext: class MockBrowserContext {},
  chromium: {
    launch: vi.fn(),
    connect: vi.fn()
  }
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  logger: {
    createContext: () => ({
      normal: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn()
    })
  }
}));

// Mock S3 and image utils
vi.mock('../providers/s3.js', () => ({
  uploadImageUrlToS3: vi.fn().mockResolvedValue('https://mocked-s3-url.com/image.jpg')
}));

vi.mock('../utils/image-utils.js', () => ({
  uploadImagesToS3AndAddUrls: vi.fn().mockImplementation(async (images) => 
    images.map((img: any) => ({
      ...img,
      mushUrl: 'https://mocked-s3-url.com/image.jpg'
    }))
  )
}));

// Mock db utils
vi.mock('../db/db-utils.js', () => ({
  formatItem: vi.fn().mockImplementation((item) => item),
  Utils: {
    formatItem: vi.fn().mockImplementation((item) => item)
  }
}));

describe('Scraper Imports', () => {
  // Get all .ts files in scrapers directory
  const scraperFiles = readdirSync(__dirname)
    .filter(file => file.endsWith('.ts'))
    .filter(file => !file.includes('.test.'))
    .filter(file => !file.includes('.d.ts'))
    .filter(file => file !== 'types.ts');

  it.each(scraperFiles)('should successfully import %s', async (file) => {
    const domain = file.replace('.ts', '');
    
    try {
      // Attempt to dynamically import the scraper
      const scraperModule = await import(`./${file}`);
      
      // Check if it has the expected exports
      const hasNamedExports = scraperModule.getItemUrls && 
         scraperModule.paginate && 
         scraperModule.scrapeItem;
      
      const hasDefaultExports = scraperModule.default?.getItemUrls && 
         scraperModule.default?.paginate && 
         scraperModule.default?.scrapeItem;
      
      if (!hasNamedExports && !hasDefaultExports) {
        // Provide detailed error message
        const exports = Object.keys(scraperModule);
        const defaultExports = scraperModule.default ? Object.keys(scraperModule.default) : [];
        throw new Error(
          `${file} is missing required exports.\n` +
          `Named exports found: ${exports.join(', ') || 'none'}\n` +
          `Default exports found: ${defaultExports.join(', ') || 'none'}\n` +
          `Required: getItemUrls, paginate, scrapeItem`
        );
      }
      
      // Verify the functions are actually functions
      if (scraperModule.getItemUrls) {
        expect(typeof scraperModule.getItemUrls).toBe('function');
        expect(typeof scraperModule.paginate).toBe('function');
        expect(typeof scraperModule.scrapeItem).toBe('function');
      } else if (scraperModule.default) {
        expect(typeof scraperModule.default.getItemUrls).toBe('function');
        expect(typeof scraperModule.default.paginate).toBe('function');
        expect(typeof scraperModule.default.scrapeItem).toBe('function');
      }
      
    } catch (error) {
      // If import fails, the test will fail with a clear error message
      if (error instanceof Error) {
        throw new Error(`Failed to import ${file}: ${error.message}`);
      }
      throw error;
    }
  });

  // Test specific type imports that were causing issues
  it('should import types correctly', async () => {
    // These imports should work without errors
    const testImports = async () => {
      const { Page } = await import('playwright');
      const types = await import('./types.js');
      const itemTypes = await import('../types/item.js');
      
      // Verify types exist (even though they're stripped at runtime)
      expect(Page).toBeDefined();
      expect(types).toBeDefined();
      expect(itemTypes).toBeDefined();
    };
    
    await expect(testImports()).resolves.not.toThrow();
  });
});

// Skip functional tests for now - the import tests are what we really need
// to catch type import errors early