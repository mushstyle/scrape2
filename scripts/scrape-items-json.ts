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

async function processLineBatch(
    lineBatch: { lineNumber: number; line: string }[],
    scraper: any,
    domain: string,
    parallelLimit?: number
): Promise<{ items: Item[]; processed: number; errors: number }> {
    const items: Item[] = [];
    let processed = 0;
    let errors = 0;
    
    // Process lines with optional parallel limit
    const processLine = async ({ lineNumber, line }: { lineNumber: number; line: string }) => {
        try {
            const jsonData = JSON.parse(line);
            const item = await scraper.scrapeItem(jsonData, { uploadToS3: false });
            
            if (item) {
                log.debug(`Processed item from line ${lineNumber}: ${item.title}`);
                return { item, success: true };
            }
            return { success: false };
        } catch (error) {
            log.error(`Error processing line ${lineNumber}:`, { error });
            return { success: false, error: true };
        }
    };
    
    let results: any[] = [];
    
    if (parallelLimit && parallelLimit < lineBatch.length) {
        // Process with limited parallelism
        for (let i = 0; i < lineBatch.length; i += parallelLimit) {
            const chunk = lineBatch.slice(i, i + parallelLimit);
            const chunkResults = await Promise.all(chunk.map(processLine));
            results.push(...chunkResults);
        }
    } else {
        // Process all in parallel
        results = await Promise.all(lineBatch.map(processLine));
    }
    
    for (const result of results) {
        if (result.success && result.item) {
            items.push(result.item);
            processed++;
        } else if (result.error) {
            errors++;
        }
    }
    
    log.debug(`Batch processed: ${processed} items, ${errors} errors`);
    
    return { items, processed, errors };
}

async function processJsonFile(filePath: string, options: {
    sites?: string[];
    batchSize: number;
    noS3: boolean;
    startLine?: number;
    parallelLimit?: number;
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
        // Process JSONL in batches for parallel processing
        const fileStream = fs.createReadStream(filePath);
        const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });
        
        let lineNumber = 0;
        let lineBatch: { lineNumber: number; line: string }[] = [];
        
        for await (const line of rl) {
            lineNumber++;
            
            // Skip lines before startLine
            if (options.startLine && lineNumber <= options.startLine) {
                continue;
            }
            
            if (!line.trim()) continue;
            
            // Collect lines in batch
            lineBatch.push({ lineNumber, line });
            
            // Process batch when it reaches batchSize
            if (lineBatch.length >= options.batchSize) {
                const batchResults = await processLineBatch(lineBatch, scraper, domain, options.parallelLimit);
                items.push(...batchResults.items);
                processed += batchResults.processed;
                errors += batchResults.errors;
                
                // Save items
                if (items.length > 0) {
                    await saveItems(domain, items, options.noS3);
                    items.length = 0;
                }
                
                lineBatch = [];
            }
        }
        
        // Process remaining lines in final batch
        if (lineBatch.length > 0) {
            const batchResults = await processLineBatch(lineBatch, scraper, domain, options.parallelLimit);
            items.push(...batchResults.items);
            processed += batchResults.processed;
            errors += batchResults.errors;
        }
    } else {
        // Process regular JSON file with parallel processing
        try {
            const fileContent = await fsPromises.readFile(filePath, 'utf-8');
            const jsonData = JSON.parse(fileContent);
            
            // Handle both single object and array
            const dataArray = Array.isArray(jsonData) ? jsonData : [jsonData];
            
            // Process in batches
            for (let i = 0; i < dataArray.length; i += options.batchSize) {
                const batch = dataArray.slice(i, i + options.batchSize);
                
                // Process batch in parallel
                const promises = batch.map(async (data, index) => {
                    try {
                        const item = await scraper.scrapeItem(data, { uploadToS3: false });
                        if (item) {
                            log.debug(`Processed item: ${item.title}`);
                            return { item, success: true };
                        }
                        return { success: false };
                    } catch (error) {
                        log.error(`Error processing item at index ${i + index}:`, { error });
                        return { success: false, error: true };
                    }
                });
                
                const results = await Promise.all(promises);
                
                for (const result of results) {
                    if (result.success && result.item) {
                        items.push(result.item);
                        processed++;
                    } else if (result.error) {
                        errors++;
                    }
                }
                
                // Save batch
                if (items.length > 0) {
                    await saveItems(domain, items, options.noS3);
                    items.length = 0;
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
            'start-line': { type: 'string' },
            'parallel-limit': { type: 'string' }
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
    const parallelLimit = values['parallel-limit'] ? parseInt(values['parallel-limit'], 10) : undefined;
    
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
    if (parallelLimit !== undefined) {
        log.normal(`Parallel limit: ${parallelLimit} items per batch`);
    } else {
        log.normal(`Parallel processing: unlimited (full batch)`);
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
        const result = await processJsonFile(filePath, { sites, batchSize, noS3, startLine, parallelLimit });
        
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