#\!/bin/bash

# List of scrapers to update (excluding already done ones)
scrapers=(
  "formi.com.ua.ts"
  "freo.com.ua.ts"
  "gaptuvalnya.com.ts"
  "grainsdeverre.com.ts"
  "griebags.com.ts"
  "hu-kh.com.ts"
  "ivaclothe.com.ts"
  "juna.com.ua.ts"
  "katerinakvit.com.ts"
  "katimoclothes.com.ts"
  "keepstyle.co.ts"
  "kobzart.com.ua.ts"
  "kseniaschnaider.com.ts"
  "kulakovsky.online.ts"
  "lecharmie.com.ts"
  "leskizzo.com.ts"
  "musthave.ua.ts"
  "nazarelli.store.ts"
  "nerses.world.ts"
  "santa-brands.com.ts"
  "serenity-wear.com.ts"
  "tago.ua.ts"
  "tgbotanical.ua.ts"
  "themakers.com.ua.ts"
  "total-white.com.ts"
  "ua.lowposh.com.ts"
  "viktoranisimov.ua.ts"
  "wonder-gallery.com.ts"
)

for scraper in "${scrapers[@]}"; do
  echo "Processing $scraper"
  # Extract domain name for console log
  domain=$(echo "$scraper" | sed 's/\.ts$//')
  
  # Check if it has uploadImagesToS3AndAddUrls
  if grep -q "uploadImagesToS3AndAddUrls" "$scraper"; then
    echo "  - Has uploadImagesToS3AndAddUrls"
  else
    echo "  - No uploadImagesToS3AndAddUrls found"
  fi
done
