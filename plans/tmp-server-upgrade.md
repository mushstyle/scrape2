# ETL API Server Authentication Upgrade

## Current Issue
The ETL API currently requires API keys to be passed as query parameters (`?api_key=xxx`), which is a security anti-pattern. API keys in URLs are logged in server access logs, browser history, and can be accidentally exposed.

## Required Changes

### 1. Add Bearer Token Support
Modify the authentication middleware to accept API keys via the standard `Authorization: Bearer <token>` header:

```javascript
// Example middleware update
function authenticate(req, res, next) {
  let apiKey;
  
  // Check Authorization header first (preferred)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    apiKey = authHeader.substring(7);
  }
  
  // Fall back to query parameter for backwards compatibility
  if (!apiKey && req.query.api_key) {
    apiKey = req.query.api_key;
    console.warn('Deprecated: API key in query parameter. Please use Authorization header.');
  }
  
  if (!apiKey) {
    return res.status(401).json({ error: 'No API key provided' });
  }
  
  // Validate API key...
}
```

### 2. Update All Endpoints
Ensure all API endpoints use this authentication method:
- `/api/scrape-runs`
- `/api/scrape-runs/:id`
- `/api/sites`
- `/api/sites/:id`
- `/api/sites/:id/scraping-config`

### 3. Migration Plan

#### Phase 1: Dual Support (Immediate)
- Accept both Bearer tokens and query parameters
- Log deprecation warnings when query parameters are used
- Update API documentation to show Bearer token as preferred method

#### Phase 2: Deprecation Notice (2 weeks)
- Add deprecation warnings to API responses when query parameter auth is used
- Email API consumers about the upcoming change

#### Phase 3: Remove Query Parameter Support (4 weeks)
- Remove support for `?api_key=xxx`
- Only accept `Authorization: Bearer <token>`

### 4. Response Format Consistency
While making auth changes, consider standardizing response formats:
- Some endpoints return `{ data: [...] }`
- Others return arrays directly
- Standardize on one format for consistency

### 5. Security Headers
Add these security headers to all API responses:
```javascript
res.set({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
});
```

## Benefits
1. **Security**: API keys not exposed in logs or URLs
2. **Standards**: Follows industry best practices
3. **Consistency**: Aligns with how other APIs work
4. **Maintainability**: Easier to manage API keys in headers vs URLs

## Testing
Ensure backwards compatibility during migration:
```bash
# Old way (should work temporarily with deprecation warning)
curl "https://api.example.com/api/scrape-runs?api_key=xxx"

# New way (preferred)
curl -H "Authorization: Bearer xxx" "https://api.example.com/api/scrape-runs"
```