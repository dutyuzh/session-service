# Session Service Testing & Presentation Guide

**Complete walkthrough for demonstrating all features in order.**

---

## Prerequisites

### 1. Start Redis

```bash
brew services start redis
redis-cli ping  # Should return: PONG
```

### 2. Start the Session Service

```bash
pnpm start
```

You should see:

```
Session service running on http://localhost:3000
Redis URL: redis://localhost:6379
```

---

## Testing Options

You have **two ways** to test the service:

### Option A: Browser UI (Recommended for Demos) 🌐

1. Open: **http://localhost:3000**
2. Click buttons to test each endpoint interactively
3. Watch the **live countdown timer** showing sliding window expiration
4. See formatted JSON responses with syntax highlighting

**Perfect for presentations** - visual, intuitive, no terminal commands needed.

---

### Option B: Terminal/Curl Testing 💻

Follow the commands in each step below. Keep the server running in one terminal, and run curl commands in a second terminal window.

**Pro tip**: Use a cookie jar file to persist cookies across requests:

```bash
# Create/update cookies in cookies.txt
curl -X POST http://localhost:3000/sessions -c cookies.txt

# Read cookies from cookies.txt
curl http://localhost:3000/sessions/me -b cookies.txt
```

---

## Step-by-Step Walkthrough

### Step 1: Create an Anonymous Session

**What it demonstrates:**

- Session creation with UUID generation
- Cookie-based authentication (HttpOnly, signed cookies)
- Session stored in Redis with 30-minute TTL
- Metadata capture (userAgent, referrer, IP)

#### Browser UI

Click **"Create Session"** button

#### Terminal

```bash
curl -X POST http://localhost:3000/sessions -c cookies.txt -v
```

**Expected Response:**

```json
{
  "success": true,
  "sessionId": "a1b2c3d4-e5f6-4789-9abc-def012345678",
  "deviceId": "device-xyz-789",
  "isNewDevice": true,
  "state": "anonymous",
  "referrer": "",
  "expiresIn": 1800,
  "deviceExpiresIn": 7776000
}
```

**Verify in Redis:**

```bash
redis-cli
127.0.0.1:6379> KEYS session:*
127.0.0.1:6379> GET session:a1b2c3d4-e5f6-4789-9abc-def012345678
127.0.0.1:6379> TTL session:a1b2c3d4-e5f6-4789-9abc-def012345678
# Should show ~1800 seconds
127.0.0.1:6379> exit
```

---

### Step 2: Fetch Session (Read Path)

**What it demonstrates:**

- Low-latency Redis lookup (<10ms target)
- Cookie extraction and validation
- Session retrieval by authenticated users

#### Browser UI

Click **"Get My Session"** button

#### Terminal

```bash
curl http://localhost:3000/sessions/me -b cookies.txt
```

**Expected Response:**

```json
{
  "success": true,
  "session": {
    "sessionId": "a1b2c3d4-e5f6-4789-9abc-def012345678",
    "deviceId": "device-xyz-789",
    "state": "anonymous",
    "createdAt": "2026-02-25T10:30:45.123Z",
    "lastSeenAt": "2026-02-25T10:30:45.123Z",
    "userAgent": "curl/7.64.1",
    "referrer": "",
    "ip": "::1",
    "attributes": {}
  },
  "latency": "2ms"
}
```

**Key observation:** Check the `latency` field - should be <10ms.

---

### Step 3: Sliding Window Expiration

**What it demonstrates:**

- 30-minute inactivity timeout
- Sliding window: each activity ping resets the TTL
- Automatic session cleanup via Redis TTL

#### Browser UI

1. Click **"Create Session"**
2. Watch the countdown timer (starts at 30:00)
3. Wait until timer shows ~29:30
4. Click **"Ping Activity"**
5. **Timer resets to 30:00!** ⏱️

This visually demonstrates the sliding window in action.

#### Terminal

**Create session and note the TTL:**

```bash
curl -X POST http://localhost:3000/sessions -c cookies.txt
redis-cli TTL session:YOUR-SESSION-ID
# Shows ~1800
```

**Wait 60 seconds, then ping activity:**

```bash
sleep 60
curl -X POST http://localhost:3000/sessions/me/activity -b cookies.txt
```

**Check TTL again:**

```bash
redis-cli TTL session:YOUR-SESSION-ID
# Back to ~1800 (TTL was refreshed!)
```

---

### Step 4: Extensible Attributes

**What it demonstrates:**

- Store custom session data (cart, preferences, campaign tracking)
- Merge semantics (existing attributes preserved)
- Flexible schema for different use cases

#### Browser UI

1. Click **"Update Attributes"**
2. Modify the JSON (e.g., add `"theme": "dark"`)
3. Click **"Get My Session"** to see merged attributes

#### Terminal

**Add shopping cart data:**

```bash
curl -X PATCH http://localhost:3000/sessions/me \
  -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"cart": ["laptop", "mouse"], "campaignId": "summer-sale"}'
```

**Add more attributes (merge behavior):**

```bash
curl -X PATCH http://localhost:3000/sessions/me \
  -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"theme": "dark", "language": "en"}'
```

**Verify both sets of attributes are preserved:**

```bash
curl http://localhost:3000/sessions/me -b cookies.txt | jq .session.attributes
```

Expected:

```json
{
  "cart": ["laptop", "mouse"],
  "campaignId": "summer-sale",
  "theme": "dark",
  "language": "en"
}
```

---

### Step 5: Persistent Login (Device Identity)

**What it demonstrates:**

- "Remember me" functionality
- 90-day device cookie for persistent identity
- Session auto-restore from device token

#### Browser UI

1. Click **"Create Session"** (creates session + device)
2. Note the session ID and device ID
3. Click **"Invalidate Session"** (deletes session, keeps device)
4. Click **"Create Session"** again
5. **Same device ID!** Session was restored

#### Terminal

**Step 1: Create session (device cookie set):**

```bash
curl -X POST http://localhost:3000/sessions -c cookies.txt
```

Response includes `"isNewDevice": true`

**Step 2: Simulate session expiration:**

```bash
# Delete session cookie (simulate expiration)
sed -i '' '/sid/d' cookies.txt
# Or on Linux: sed -i '/sid/d' cookies.txt
```

**Step 3: Create new session with existing device:**

```bash
curl -X POST http://localhost:3000/sessions -b cookies.txt -c cookies.txt
```

Response shows `"isNewDevice": false` - device was recognized!

**Verify in Redis:**

```bash
redis-cli
127.0.0.1:6379> KEYS device:*
127.0.0.1:6379> GET device:YOUR-DEVICE-ID
# Device persists for 90 days
127.0.0.1:6379> TTL device:YOUR-DEVICE-ID
# Shows ~7776000 seconds (90 days)
```

---

### Step 6: Attach Identity (Login)

**What it demonstrates:**

- Transition from anonymous → authenticated
- Session ID rotation (security best practice)
- Event tracking/audit trail
- Cookie refresh with new session ID

#### Browser UI

1. Click **"Create Session"** (anonymous session)
2. Note the session ID
3. Click **"Attach Identity"** and enter a userId (e.g., "alice")
4. Observe: **New session ID!** (rotation happened)
5. Session state changed to "authenticated"

#### Terminal

**Create anonymous session:**

```bash
curl -X POST http://localhost:3000/sessions -c cookies.txt
```

Note the `sessionId` from the response.

**Login (attach identity):**

```bash
curl -X POST http://localhost:3000/sessions/me/attach-identity \
  -b cookies.txt -c cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"userId": "alice"}'
```

**Expected Response:**

```json
{
  "success": true,
  "message": "Identity attached successfully",
  "session": {
    "sessionId": "NEW-SESSION-ID-HERE",
    "userId": "alice",
    "state": "authenticated",
    "events": [
      {
        "type": "SESSION_ROTATED",
        "timestamp": "2026-02-25T10:35:00.000Z",
        "data": {
          "reason": "IDENTITY_ATTACHED",
          "previousSessionId": "OLD-SESSION-ID"
        }
      }
    ]
  }
}
```

**Key observation:** Session ID changed (rotation) for security.

---

### Step 7: Persistent Device Recognition

**What it demonstrates:**

- Device cookie persists across session expirations (90 days)
- `isNewDevice: false` when device is recognized
- Foundation for "remember me" functionality
- Device tracking for returning users

**Note:** Current implementation recognizes the device but creates a new anonymous session. The userId is stored in the device token, but automatic session restoration with userId requires the user to log in again (Step 6).

#### Browser UI

1. Click **"Create Session"** and login as a user (complete Step 6 first)
2. Note your device ID from the response
3. Click **"Simulate Session Expiry & Restore"** button in Step 7
4. This automatically:
   - Deletes your session cookie (simulating expiration)
   - Attempts to fetch the session (returns 404)
   - Shows device is still recognized
5. **Same device ID!** (`isNewDevice: false`)
6. Session state is "anonymous" - user must login again
7. Click **"Attach Identity"** to login again with the same userId

#### Terminal

**Login as alice:**

```bash
curl -X POST http://localhost:3000/sessions -c cookies.txt
curl -X POST http://localhost:3000/sessions/me/attach-identity \
  -b cookies.txt -c cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"userId": "alice"}'
```

**Check response - note deviceId:**

```bash
curl http://localhost:3000/sessions/me -b cookies.txt | jq -r .session.deviceId
# Save this deviceId for comparison
```

**Simulate session expiration (delete session cookie, keep device cookie):**

```bash
sed -i '' '/sid/d' cookies.txt
# Or on Linux: sed -i '/sid/d' cookies.txt
```

**Create new session (device cookie still present):**

```bash
curl -X POST http://localhost:3000/sessions -b cookies.txt -c cookies.txt
```

**Expected Response:**

```json
{
  "success": true,
  "sessionId": "new-session-id",
  "deviceId": "same-device-id-as-before",
  "isNewDevice": false, // ← Device was recognized!
  "state": "anonymous", // ← New anonymous session
  "referrer": "",
  "expiresIn": 1800,
  "deviceExpiresIn": 7776000
}
```

**Verify device persists in Redis:**

```bash
redis-cli
127.0.0.1:6379> KEYS device:*
127.0.0.1:6379> GET device:YOUR-DEVICE-ID
# Device still has userId from previous login
127.0.0.1:6379> TTL device:YOUR-DEVICE-ID
# Still shows ~90 days
```

**Key observation:** Device is recognized (`isNewDevice: false`), but session is anonymous. This demonstrates persistent device tracking across sessions. For full "remember me" (automatic userId restoration), you would enhance the session creation logic to check if the device has a userId and automatically attach it.

---

### Step 8: Multi-Device Tracking

**What it demonstrates:**

- Track all devices for a logged-in user
- Redis Sets for multi-device management
- List all active sessions per user

#### Browser UI

**To demo multi-device tracking, you need multiple devices/browsers:**

**Option 1: Using multiple browsers**
1. In **Chrome**: Create session and login as "alice"
2. In **Firefox**: Create session and login as "alice" (same userId)
3. In **Safari** (or Chrome Incognito): Create session and login as "alice"
4. Go back to any browser and click **"Show My Devices"**
5. You'll see all 3 devices with different deviceIds!

**Option 2: Using one browser (simpler for quick demo)**
1. Click **"Create Session"** and login as "alice"
2. Click **"Invalidate Session"** (this keeps the device cookie)
3. Click **"Create Session"** again - creates new session with same device
4. Click **"Attach Identity"** and login as "alice" again
5. Now open **Incognito/Private window** at http://localhost:3000
6. In Incognito: Click **"Create Session"** and login as "alice"
7. Go back to normal window and click **"Show My Devices"**
8. You'll see 2 devices: original device + incognito device

**Expected display:**
```
👤 User: alice
📱 Total Devices: 2

Device 1:
  ID: device-abc-123
  Created: 2026-03-03T10:00:00Z
  Last Used: 2026-03-03T10:15:00Z
  User Agent: Mozilla/5.0 (Macintosh...)

Device 2:
  ID: device-def-456
  Created: 2026-03-03T10:05:00Z
  Last Used: 2026-03-03T10:10:00Z
  User Agent: Mozilla/5.0 (Macintosh...)
```

#### Terminal

**Create sessions on "multiple devices" (use different cookie files):**

```bash
# Device 1 (laptop)
curl -X POST http://localhost:3000/sessions -c laptop.txt
curl -X POST http://localhost:3000/sessions/me/attach-identity \
  -b laptop.txt -c laptop.txt \
  -H "Content-Type: application/json" \
  -d '{"userId": "alice"}'

# Device 2 (phone)
curl -X POST http://localhost:3000/sessions -c phone.txt
curl -X POST http://localhost:3000/sessions/me/attach-identity \
  -b phone.txt -c phone.txt \
  -H "Content-Type: application/json" \
  -d '{"userId": "alice"}'

# Device 3 (tablet)
curl -X POST http://localhost:3000/sessions -c tablet.txt
curl -X POST http://localhost:3000/sessions/me/attach-identity \
  -b tablet.txt -c tablet.txt \
  -H "Content-Type: application/json" \
  -d '{"userId": "alice"}'
```

**List all devices for alice:**

```bash
curl http://localhost:3000/users/me/devices -b laptop.txt
```

**Expected Response:**

```json
{
  "success": true,
  "userId": "alice",
  "devices": [
    {
      "deviceId": "device-1",
      "userId": "alice",
      "createdAt": "2026-02-25T10:00:00.000Z",
      "lastUsedAt": "2026-02-25T10:30:00.000Z",
      "userAgent": "curl/7.64.1"
    },
    {
      "deviceId": "device-2",
      "userId": "alice",
      "createdAt": "2026-02-25T11:00:00.000Z",
      "lastUsedAt": "2026-02-25T11:15:00.000Z",
      "userAgent": "curl/7.64.1"
    },
    {
      "deviceId": "device-3",
      "userId": "alice",
      "createdAt": "2026-02-25T12:00:00.000Z",
      "lastUsedAt": "2026-02-25T12:10:00.000Z",
      "userAgent": "curl/7.64.1"
    }
  ],
  "deviceCount": 3
}
```

**Verify in Redis:**

```bash
redis-cli
127.0.0.1:6379> SMEMBERS user:alice:devices
# Shows all 3 device IDs
```

---

### Step 9: Session Merge

**What it demonstrates:**

- Merge anonymous session data into authenticated session
- Cart transfer scenario (shop anonymously, then login)
- Attribute preservation during merge

#### Browser UI

1. Create session A, add attributes (e.g., cart items)
2. Create session B in incognito/different browser
3. Login to session B
4. Use merge endpoint to transfer session A data to B

#### Terminal

**Scenario: User shops anonymously, then logs in on different device**

**Anonymous session (source):**

```bash
# Session A: Anonymous shopping
curl -X POST http://localhost:3000/sessions -c sessionA.txt
curl -X PATCH http://localhost:3000/sessions/me \
  -b sessionA.txt \
  -H "Content-Type: application/json" \
  -d '{"cart": ["laptop", "mouse"], "referrer": "google.com"}'
```

**Get source session ID:**

```bash
curl http://localhost:3000/sessions/me -b sessionA.txt | jq -r .session.sessionId
# Copy this sessionId, you'll need it for merge
```

**New session (target) - user logs in:**

```bash
# Session B: User logs in on different device
curl -X POST http://localhost:3000/sessions -c sessionB.txt
curl -X POST http://localhost:3000/sessions/me/attach-identity \
  -b sessionB.txt -c sessionB.txt \
  -H "Content-Type: application/json" \
  -d '{"userId": "alice"}'

# Add some attributes to target
curl -X PATCH http://localhost:3000/sessions/me \
  -b sessionB.txt \
  -H "Content-Type: application/json" \
  -d '{"theme": "dark"}'
```

**Merge sessions (transfer cart from A to B):**

```bash
curl -X POST http://localhost:3000/sessions/merge \
  -b sessionB.txt \
  -H "Content-Type: application/json" \
  -d '{
    "sourceSessionId": "SOURCE-SESSION-ID-FROM-A",
    "targetSessionId": "current"
  }'
```

**Verify merged attributes:**

```bash
curl http://localhost:3000/sessions/me -b sessionB.txt | jq .session.attributes
```

Expected (both carts merged):

```json
{
  "cart": ["laptop", "mouse"],
  "referrer": "google.com",
  "theme": "dark"
}
```

---

### Step 10: Session Invalidation

**What it demonstrates:**

- Explicit logout functionality
- Session deletion from Redis
- Cookie clearance
- Security: prevent session reuse

#### Browser UI

1. Click **"Create Session"**
2. Click **"Invalidate Session"** (logout)
3. Try **"Get My Session"** - should fail with 401

#### Terminal

**Create and login:**

```bash
curl -X POST http://localhost:3000/sessions -c cookies.txt
curl -X POST http://localhost:3000/sessions/me/attach-identity \
  -b cookies.txt -c cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"userId": "alice"}'
```

**Logout (invalidate session):**

```bash
curl -X POST http://localhost:3000/sessions/me/invalidate -b cookies.txt -c cookies.txt
```

**Try to fetch session (should fail):**

```bash
curl http://localhost:3000/sessions/me -b cookies.txt
```

Expected: `401 Unauthorized`

**Verify in Redis:**

```bash
redis-cli
127.0.0.1:6379> KEYS session:*
# Session key deleted
```

---

### Step 11: Cross-Service Continuity

**What it demonstrates:**

- Internal API for microservices
- Shared secret authentication
- Cross-service session access without cookies

#### Terminal

**Start the demo microservice (Service B):**

Open a **third terminal window**:

```bash
node service-b.js
```

You should see:

```
Service B (Email) running on http://localhost:4000
Connected to session service at http://localhost:3000
```

**Create session in main service:**

```bash
curl -X POST http://localhost:3000/sessions -c cookies.txt
curl -X POST http://localhost:3000/sessions/me/attach-identity \
  -b cookies.txt -c cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"userId": "alice"}'

# Add email preference
curl -X PATCH http://localhost:3000/sessions/me \
  -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"emailPreference": "daily-digest"}'
```

**Get session ID:**

```bash
curl http://localhost:3000/sessions/me -b cookies.txt | jq -r .session.sessionId
# Copy this sessionId
```

**Call Service B, which internally fetches session data:**

```bash
curl -X POST http://localhost:4000/send-email \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "YOUR-SESSION-ID",
    "emailType": "welcome"
  }'
```

**Expected Response:**

```json
{
  "success": true,
  "message": "Email sent successfully",
  "emailType": "welcome",
  "recipient": "alice",
  "sessionData": {
    "userId": "alice",
    "state": "authenticated",
    "attributes": {
      "emailPreference": "daily-digest"
    }
  }
}
```

**Key observation:** Service B accessed session data using internal API without cookies!

**Check Service B logs** (in the third terminal):

```
[Service B] Fetching session abc-123 from session service...
[Service B] Session retrieved: alice (authenticated)
[Service B] Sending welcome email to alice
```

---

## Advanced Testing Scenarios

### Health Check

```bash
curl http://localhost:3000/health
```

**Expected:**

```json
{
  "status": "healthy",
  "redis": "connected",
  "timestamp": "2026-02-25T10:00:00.000Z"
}
```

### Error Cases

**No session cookie:**

```bash
curl http://localhost:3000/sessions/me
# Expected: 401 Unauthorized
```

**Invalid session ID:**

```bash
curl http://localhost:3000/sessions/me -H "Cookie: sid=invalid-session-id"
# Expected: 404 Not Found
```

**Missing userId on login:**

```bash
curl -X POST http://localhost:3000/sessions/me/attach-identity \
  -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{}'
# Expected: 400 Bad Request
```

---

## Performance Testing

### Latency Verification

**Test Redis lookup performance:**

```bash
# Create session
curl -X POST http://localhost:3000/sessions -c cookies.txt

# Run 10 fetches and check latency
for i in {1..10}; do
  curl -s http://localhost:3000/sessions/me -b cookies.txt | jq .latency
done
```

Expected: Most responses <10ms (typically 1-3ms locally)

### Sliding Window Stress Test

**Verify TTL refreshes correctly:**

```bash
redis-cli TTL session:YOUR-SESSION-ID
curl -X POST http://localhost:3000/sessions/me/activity -b cookies.txt
redis-cli TTL session:YOUR-SESSION-ID
# TTL should reset to 1800
```

---

## Cleanup

**Clear all sessions:**

```bash
redis-cli
127.0.0.1:6379> FLUSHDB
127.0.0.1:6379> exit
```

**Stop services:**

```bash
# Stop session service: Ctrl+C in terminal 1
# Stop service-b: Ctrl+C in terminal 3
# Stop Redis:
brew services stop redis
```

**Delete cookie files:**

```bash
rm cookies.txt laptop.txt phone.txt tablet.txt sessionA.txt sessionB.txt
```

---

## Presentation Tips

### For Live Demos

1. **Start with browser UI** - visual impact, easy to understand
2. **Show the countdown timer** - demonstrates sliding window clearly
3. **Use Redis CLI in a side-by-side terminal** - show data persistence
4. **Have Service B running** - demonstrates microservices architecture

### For Technical Interviews

1. **Explain the "why" of each feature** as you test it
2. **Highlight tradeoffs** (e.g., JSON blob vs Redis Hash)
3. **Discuss scalability** (Redis Cluster, sharding)
4. **Show security awareness** (cookie flags, session rotation)

### Key Talking Points

- **Latency**: Sub-10ms session lookups (show in response)
- **Sliding window**: Visual countdown timer demonstrates it clearly
- **Security**: HttpOnly cookies, signed cookies, session rotation on login
- **Extensibility**: Attributes support any JSON data
- **Persistence**: 90-day device token for "remember me"
- **Multi-service**: Internal API for microservices architecture
- **Production-ready considerations**: Rate limiting, CSRF protection, Redis Cluster

---

## Quick Reference: All Endpoints

| Endpoint                       | Method | Auth   | Purpose                      |
| ------------------------------ | ------ | ------ | ---------------------------- |
| `/health`                      | GET    | None   | Service health check         |
| `/sessions`                    | POST   | None   | Create anonymous session     |
| `/sessions/me`                 | GET    | Cookie | Fetch current session        |
| `/sessions/me/activity`        | POST   | Cookie | Refresh session TTL          |
| `/sessions/me`                 | PATCH  | Cookie | Update attributes            |
| `/sessions/me/attach-identity` | POST   | Cookie | Login (attach userId)        |
| `/sessions/me/invalidate`      | POST   | Cookie | Logout (delete session)      |
| `/users/me/devices`            | GET    | Cookie | List user's devices          |
| `/sessions/merge`              | POST   | Cookie | Merge two sessions           |
| `/internal/sessions/:sid`      | GET    | Secret | Cross-service session access |

---

## Troubleshooting

**Redis not running:**

```bash
redis-cli ping
# If fails: brew services start redis
```

**Port 3000 already in use:**

```bash
lsof -i :3000
kill -9 <PID>
```

**Cookies not persisting:**

- Make sure you use `-c cookies.txt` to save cookies
- Use `-b cookies.txt` to send cookies
- Check the file exists: `cat cookies.txt`

**Session not found after creation:**

- Check Redis is running: `redis-cli ping`
- Verify session in Redis: `redis-cli KEYS session:*`
- Check TTL hasn't expired: `redis-cli TTL session:YOUR-ID`

---

**End of Testing Guide** ✅

For implementation details, see [README.md](README.md).
For system architecture and design decisions, see [public/docs.html](public/docs.html).
