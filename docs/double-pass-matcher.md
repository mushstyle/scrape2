# Double-Pass Matcher Algorithm

## Overview

The double-pass matcher is an efficient algorithm for matching URLs to browser sessions while minimizing resource waste. It intelligently manages sessions by analyzing URL requirements and creating exactly the right type of sessions needed.

## Algorithm Steps

### Step 1: Get URLs
- Fetches URLs from the specified source (start pages or scrape runs)
- Respects `sessionLimit` per domain to avoid overwhelming sites
- Loads site configurations to understand proxy requirements

### Step 2: First Pass - Match Existing Sessions
- Gets all currently active sessions
- Runs the distributor to match URLs to existing sessions
- Identifies which sessions were used and which are excess

### Step 3: Session Allocation
- **Terminate excess sessions**: Kill any sessions not used in the first pass
- **Calculate sessions needed**: `instanceLimit - matchedUrls`
- **Analyze requirements**: Look at the next N unmatched URLs to determine proxy needs
- **Create targeted sessions**: Create new sessions based on the specific proxy requirements

### Step 4: Second Pass (if new sessions created)
- Run the distributor again with all sessions (existing + new)
- Match as many URLs as possible up to the instance limit

## Key Benefits

1. **Resource Efficiency**: Only keeps sessions that are actively needed
2. **Smart Session Creation**: Creates sessions that match upcoming URL requirements
3. **Double Pass Maximum**: Guarantees at most two distributor runs for efficiency
4. **Proxy-Aware**: Analyzes proxy requirements to create the right type of sessions

## Usage

```bash
# Use start pages with 10 instance limit
npm run example:double-pass-matcher -- --source start-pages --instance-limit 10

# Use scrape runs from last 7 days with 5 instance limit
npm run example:double-pass-matcher -- --source scrape-runs --since 7d --instance-limit 5

# Use local browser provider
npm run example:double-pass-matcher -- --source start-pages --provider local --instance-limit 3
```

## Parameters

- `--source`: Where to get URLs from (`start-pages` or `scrape-runs`)
- `--since`: Time range for scrape runs (e.g., `7d`, `48h`, `30m`)
- `--instance-limit`: Maximum number of concurrent URL-session pairs
- `--provider`: Browser provider to use (`browserbase` or `local`)

## Example Flow

```
1. Get 50 URLs from various domains
2. Find 3 existing browserbase sessions
3. First pass: Match 3 URLs to the 3 sessions
4. Instance limit is 10, so we need 7 more sessions
5. Analyze next 7 URLs:
   - 4 need datacenter/US proxies
   - 2 need residential/UK proxies  
   - 1 needs no proxy
6. Create 7 sessions matching these requirements
7. Second pass: Match total of 10 URLs to sessions
8. Result: 10 URLs matched efficiently with zero wasted sessions
```

## Integration with Central Engine

This algorithm is designed to be the core of a central orchestration engine:

```typescript
class OrchestrationEngine {
  async processUrls(urls: string[], instanceLimit: number) {
    // Step 1: Get existing sessions
    const sessions = await this.sessionManager.getActiveSessions();
    
    // Step 2: First pass
    const firstMatch = distributor.match(urls, sessions);
    
    // Step 3: Session allocation
    await this.killExcessSessions(firstMatch.excess);
    const newSessions = await this.createSmartSessions(
      firstMatch.unmatched, 
      instanceLimit - firstMatch.matched.length
    );
    
    // Step 4: Second pass (if needed)
    if (newSessions.length > 0) {
      return distributor.match(urls, [...sessions, ...newSessions]);
    }
    
    return firstMatch;
  }
}
```

## Performance Characteristics

- **Time Complexity**: O(n*m) where n=URLs and m=sessions
- **Distributor Calls**: Maximum 2 (guaranteed)
- **Session Efficiency**: Near 100% - only creates sessions that can be used
- **Network Calls**: Minimal - batched session creation

## Best Practices

1. Set `instanceLimit` based on your infrastructure capacity
2. Use appropriate `--since` values to avoid processing stale data
3. Monitor the efficiency percentage to ensure good matching
4. Run periodically to maintain optimal session pool

## Future Enhancements

- Session caching based on historical usage patterns
- Predictive session pre-warming during low-activity periods
- Multi-geo session pooling for global operations
- Session health monitoring and auto-recovery