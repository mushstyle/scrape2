#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { promises as fsPromises } from 'fs';
import readline from 'readline';
import { parseArgs } from 'util';
import { logger } from '../src/utils/logger.js';
import { getSiteConfig } from '../src/drivers/site-config.js';
import { getJsonScraper } from '../src/scrapers-json/index.js';
import { ETLDriver } from '../src/drivers/etl.js';
import { uploadImagesToS3AndAddUrls } from '../src/utils/image-utils.js';
import type { Item } from '../src/types/item.js';

const log = logger.createContext('scrape-items-json');

async function processJsonFile(filePath: string, options: {
    sites?: string[];
    batchSize: number;
    noS3: boolean;
    startLine?: number;
}): Promise<{ processed: number; errors: number }> {
    const fileName = path.basename(filePath);
    
    // Extract domain from filename (e.g., shop.diesel.com.jsonl -> shop.diesel.com)
    const domain = fileName.replace(/\.(json|jsonl)$/, '');
    
    // Skip if sites filter provided and domain not in list
    if (options.sites && !options.sites.includes(domain)) {
        log.debug(`Skipping ${fileName} - domain not in sites filter`);
        return { processed: 0, errors: 0 };
    }
    
    log.normal(`Processing ${fileName} for domain: ${domain}`);
    
    // Get site config from API
    let siteConfig;
    try {
        siteConfig = await getSiteConfig(domain);
    } catch (error) {
        log.error(`Failed to get config for ${domain}:`, { error });
        return { processed: 0, errors: 1 };
    }
    
    // Verify it's a JSON scraper
    if (siteConfig.scraperType !== 'json') {
        log.error(`Site ${domain} is not configured for JSON scraping (type: ${siteConfig.scraperType})`);
        return { processed: 0, errors: 1 };
    }
    
    // Get the JSON scraper
    const scraper = getJsonScraper(domain, siteConfig.scraper);
    if (!scraper) {
        log.error(`No JSON scraper found for ${domain}`);
        return { processed: 0, errors: 1 };
    }
    
    let processed = 0;
    let errors = 0;
    const items: Item[] = [];
    
    const isJsonl = filePath.endsWith('.jsonl');
    
    if (isJsonl) {
        // Process JSONL line by line
        const fileStream = fs.createReadStream(filePath);
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });
        
        let lineNumber = 0;
        for await (const line of rl) {
            lineNumber++;
            
            // Skip lines before startLine
            if (options.startLine && lineNumber <= options.startLine) {
                continue;
            }
            
            if (!line.trim()) continue;
            
            try {
                const jsonData = JSON.parse(line);
                const item = await scraper.scrapeItem(jsonData, { uploadToS3: false });
                
                if (item) {
                    // Debug: Log the item structure
                    log.debug(`Item structure:`, {
                        sourceUrl: item.sourceUrl,
                        product_id: item.product_id,
                        title: item.title,
                        hasImages: !!item.images?.length
                    });
                    items.push(item);
                    processed++;
                    log.debug(`Processed item from line ${lineNumber}: ${item.title}`);
                    
                    // Batch save
                    if (items.length >= options.batchSize) {
                        await saveItems(domain, items, options.noS3);
                        items.length = 0;
                    }
                }
            } catch (error) {
                log.error(`Error processing line ${lineNumber}:`, { error });
                errors++;
            }
        }
    } else {
        // Process regular JSON file
        try {
            const fileContent = await fsPromises.readFile(filePath, 'utf-8');
            const jsonData = JSON.parse(fileContent);
            
            // Handle both single object and array
            const dataArray = Array.isArray(jsonData) ? jsonData : [jsonData];
            
            for (const data of dataArray) {
                try {
                    const item = await scraper.scrapeItem(data, { uploadToS3: false });
                    
                    if (item) {
                        items.push(item);
                        processed++;
                        log.debug(`Processed item: ${item.title}`);
                        
                        // Batch save
                        if (items.length >= options.batchSize) {
                            await saveItems(domain, items, options.noS3);
                            items.length = 0;
                        }
                    }
                } catch (error) {
                    log.error(`Error processing item:`, { error });
                    errors++;
                }
            }
        } catch (error) {
            log.error(`Error reading JSON file:`, { error });
            return { processed: 0, errors: 1 };
        }
    }
    
    // Save remaining items
    if (items.length > 0) {
        await saveItems(domain, items, options.noS3);
    }
    
    log.normal(`Completed ${fileName}: ${processed} items processed, ${errors} errors`);
    return { processed, errors };
}

async function saveItems(domain: string, items: Item[], noS3: boolean): Promise<void> {
    try {
        // Upload images to S3 if enabled
        let itemsToSave = items;
        if (!noS3) {
            log.debug(`Uploading images to S3 for ${items.length} items`);
            itemsToSave = await Promise.all(
                items.map(async (item) => {
                    const imagesWithS3 = await uploadImagesToS3AndAddUrls(item.images, item.sourceUrl);
                    return { ...item, images: imagesWithS3 };
                })
            );
        }
        
        const etlDriver = new ETLDriver({ batchSize: itemsToSave.length });
        const result = await etlDriver.addItemsBatch(itemsToSave);
        
        // Debug: Log successful items
        if (result.successful.length > 0) {
            log.debug(`Successfully saved items:`, result.successful.map(s => ({
                itemId: s.itemId.substring(0, 8),
                fullIdLength: s.itemId.length,
                success: s.success
            })));
        }
        
        if (result.failed.length > 0) {
            log.error(`Failed to save ${result.failed.length} items`);
            result.failed.forEach(f => {
                log.error(`Failed item: ${f.itemId || 'unknown'} - ${f.error}`);
            });
        }
        
        log.normal(`Saved batch: ${result.successful.length} successful, ${result.failed.length} failed`);
        
        // Debug: Verify items exist (only in debug mode)
        if (result.successful.length > 0 && process.env.LOG_LEVEL === 'debug') {
            const firstItemId = result.successful[0].itemId;
            const exists = await etlDriver.itemExists(firstItemId);
            log.debug(`Verification: Item ${firstItemId.substring(0, 8)} exists in ETL: ${exists}`);
        }
    } catch (error) {
        log.error(`Failed to save items batch:`, { error });
        throw error;
    }
}

async function main() {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            dir: { type: 'string' },
            sites: { type: 'string' },
            'batch-size': { type: 'string' },
            'no-s3': { type: 'boolean' },
            'start-line': { type: 'string' }
        }
    });
    
    if (!values.dir) {
        console.error('Error: --dir parameter is required');
        console.error('Usage: npm run scrape items:json -- --dir=<DIR> [options]');
        process.exit(1);
    }
    
    const dir = values.dir;
    const sites = values.sites?.split(',').map(s => s.trim()).filter(Boolean);
    const batchSize = parseInt(values['batch-size'] || '100', 10);
    const noS3 = values['no-s3'] || false;
    const startLine = values['start-line'] ? parseInt(values['start-line'], 10) : undefined;
    
    // Verify directory exists
    try {
        const stats = await fsPromises.stat(dir);
        if (!stats.isDirectory()) {
            log.error(`Path ${dir} is not a directory`);
            process.exit(1);
        }
    } catch (error) {
        log.error(`Directory ${dir} does not exist`);
        process.exit(1);
    }
    
    log.normal(`Processing JSON files from ${dir}`);
    if (sites) {
        log.normal(`Filtering for sites: ${sites.join(', ')}`);
    }
    log.normal(`Batch size: ${batchSize}, S3 upload: ${!noS3}`);
    if (startLine !== undefined) {
        log.normal(`Starting from line: ${startLine + 1} (0-indexed: ${startLine})`);
    }
    
    // Find all JSON/JSONL files
    const files = await fsPromises.readdir(dir);
    const jsonFiles = files.filter(f => f.endsWith('.json') || f.endsWith('.jsonl'));
    
    if (jsonFiles.length === 0) {
        log.error(`No JSON or JSONL files found in ${dir}`);
        process.exit(1);
    }
    
    log.normal(`Found ${jsonFiles.length} JSON/JSONL files`);
    
    let totalProcessed = 0;
    let totalErrors = 0;
    let filesProcessed = 0;
    
    for (const file of jsonFiles) {
        const filePath = path.join(dir, file);
        const result = await processJsonFile(filePath, { sites, batchSize, noS3, startLine });
        
        if (result.processed > 0 || result.errors > 0) {
            filesProcessed++;
            totalProcessed += result.processed;
            totalErrors += result.errors;
        }
    }
    
    log.normal('');
    log.normal('=== Summary ===');
    log.normal(`Files processed: ${filesProcessed}/${jsonFiles.length}`);
    log.normal(`Total items: ${totalProcessed}`);
    log.normal(`Total errors: ${totalErrors}`);
    
    process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch((error) => {
    log.error('Fatal error:', { error });
    process.exit(1);
});