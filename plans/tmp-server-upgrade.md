# ETL API Server Authentication Upgrade

## Current Issue
The ETL API currently requires API keys to be passed as query parameters (`?api_key=xxx`), which is a security anti-pattern. API keys in URLs are logged in server access logs, browser history, and can be accidentally exposed.

## Required Changes

### 1. Replace Query Parameter Auth with Bearer Token
Modify the authentication middleware to ONLY accept API keys via the standard `Authorization: Bearer <token>` header:

```javascript
// Example middleware update
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      error: 'Missing or invalid Authorization header. Use: Authorization: Bearer <api_key>' 
    });
  }
  
  const apiKey = authHeader.substring(7);
  
  if (!apiKey) {
    return res.status(401).json({ error: 'No API key provided' });
  }
  
  // Validate API key...
}
```

**Remove all `req.query.api_key` checks immediately.**

### 2. Update All Endpoints
Ensure all API endpoints use this authentication method:
- `/api/scrape-runs`
- `/api/scrape-runs/:id`
- `/api/sites`
- `/api/sites/:id`
- `/api/sites/:id/scraping-config`

### 3. Implementation Steps

1. **Update authentication middleware** to only accept Bearer tokens
2. **Remove all query parameter parsing** for api_key
3. **Update error messages** to guide users to the correct format
4. **Test all endpoints** to ensure they reject query parameter auth
5. **Deploy immediately** - no backwards compatibility needed

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
Verify that ONLY Bearer token authentication works:
```bash
# This should FAIL with 401 error
curl "https://api.example.com/api/scrape-runs?api_key=xxx"
# Expected: {"error": "Missing or invalid Authorization header. Use: Authorization: Bearer <api_key>"}

# This should SUCCEED
curl -H "Authorization: Bearer xxx" "https://api.example.com/api/scrape-runs"
# Expected: Normal API response
```

## Client Updates Required
All API clients must update immediately to use Bearer token authentication. The query parameter method will stop working as soon as this change is deployed.