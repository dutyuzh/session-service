/* ======================================
   Session Service - On-Prem Implementation
   ====================================== */

// Load environment variables from .env file
import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import Redis from "ioredis";
import { v4 as uuidv4 } from "uuid";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// ES module compatibility - get __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIE_SECRET = process.env.COOKIE_SECRET;
const INTERNAL_API_SECRET =
  process.env.INTERNAL_API_SECRET || "dev-secret-change-in-prod";

/* ============ Redis Connection ============ */
// Initialize Redis client for session storage
// Redis is chosen for:
//  - Fast in-memory reads (<10ms latency)
//  - Built-in TTL/expiration support
//  - Atomic operations
//  - High availability (Cluster/Sentinel support)
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

/* ============ Middleware Stack ============ */
// Parse JSON request bodies
app.use(express.json());

/* ============ Cookie Security Configuration ============
 * All cookies are set with these security flags:
 *
 * 1. httpOnly: true
 *    - Prevents JavaScript access via document.cookie
 *    - Protection: XSS attacks cannot steal session tokens
 *    - Trade-off: Frontend can't read session ID (must call /sessions/me)
 *
 * 2. secure: false (dev) / true (production)
 *    - Only send cookie over HTTPS when true
 *    - Protection: Man-in-the-middle cannot intercept session cookie
 *    - Dev note: Set to false for local HTTP testing, true in production
 *
 * 3. sameSite: "lax"
 *    - Cookie sent on top-level navigation (e.g., clicking links)
 *    - Cookie NOT sent on cross-site POST/fetch (e.g., CSRF attacks)
 *    - Protection: PARTIAL CSRF protection (blocks cross-site POST)
 *    - Gap: Safe top-level navigation (GET requests) DO send cookies
 *    - Production TODO: Add CSRF token for state-changing operations
 *
 * 4. signed: true
 *    - Cookie value includes HMAC signature using COOKIE_SECRET
 *    - Protection: Tampering detected (e.g., changing session ID)
 *    - Verification: Read from req.signedCookies (not req.cookies)
 *    - Invalid signatures are rejected automatically
 *
 * 5. maxAge: Distinct lifetimes for different purposes
 *    - Session cookie (sid): 30 minutes - expires quickly for security
 *    - Device cookie (did): 90 days - enables "remember me" behavior
 *    - Implementation: Sliding window (session extends on activity)
 *
 * Combined Protection:
 *  - XSS: httpOnly prevents script access
 *  - CSRF (Partial): sameSite=lax blocks cross-site POST but not top-level GET
 *  - MITM: secure (in prod) prevents interception
 *  - Tampering: signed prevents cookie modification
 *  - Theft: Short session TTL limits damage window
 *
 * CSRF Protection Strategy (Production Enhancement):
 *  Current: sameSite=lax provides baseline CSRF protection
 *  Gap: State-changing endpoints (POST/PATCH) are protected, but a site
 *       could link to our endpoints and cookies would be sent
 *  Recommended additions:
 *   1. CSRF Token: Issue token on session creation, validate on writes
 *   2. Origin/Referer checking: Verify requests come from same origin
 *   3. Custom header: Require X-CSRF-Token header (prevents simple links)
 *
 *  Implementation example:
 *   - POST /sessions returns { sessionId, csrfToken }
 *   - All write endpoints (PATCH /sessions/me, POST /attach-identity, etc.)
 *     check req.headers['x-csrf-token'] matches session's stored token
 *   - Rotate CSRF token on identity attachment (like session ID rotation)
 */
app.use(cookieParser(COOKIE_SECRET));

/* ============ CORS Configuration ============
 * Current Setup: Same-Origin (No CORS needed)
 * ============================================
 * - UI served from: http://localhost:3000/ (express.static below)
 * - API served from: http://localhost:3000/sessions (this Express app)
 * - Result: Same origin, browser allows cookies automatically
 *
 * Why CORS middleware is present:
 *  - Future flexibility: If you deploy UI separately (e.g., Vercel), enable CORS
 *  - No harm: Same-origin requests ignore CORS headers
 *  - Example: If you serve UI from localhost:5173 (Vite dev server), uncomment CORS
 *
 * Deployment Scenarios:
 *
 *  1. Same-Origin (current, recommended):
 *     - UI: http://yoursite.com/ (express.static)
 *     - API: http://yoursite.com/sessions (same Express app)
 *     - CORS: Not needed (disable middleware for slight perf gain)
 *     - Cookies: Work automatically
 *     - Security: Simplest, no cross-origin concerns
 *
 *  2. Cross-Origin (separate deployments):
 *     - UI: http://app.yoursite.com (separate CDN/server)
 *     - API: http://api.yoursite.com (this Express app)
 *     - CORS: Required (uncomment middleware below)
 *     - Cookies: Need credentials: 'include' + Access-Control-Allow-Credentials
 *     - Security: Must whitelist specific origins (not *)
 *
 * Production TODO:
 *  - If same-origin: Remove or disable CORS middleware (unnecessary overhead)
 *  - If cross-origin: Replace 'localhost:3000' with environment variable
 */

// CORS middleware (currently unnecessary but left for flexibility)
// Comment out this entire block if deploying same-origin for slight perf gain
app.use((req, res, next) => {
  // In production, replace hardcoded origin with environment variable
  const allowedOrigins = [
    "http://localhost:3000", // Current: Same origin (UI served by this server)
    // "http://localhost:5173", // Example: Vite dev server
    // process.env.UI_ORIGIN, // Example: Production UI domain
  ];

  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true"); // Required for cookies
    res.header("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token");
    res.header(
      "Access-Control-Allow-Methods",
      "GET, POST, PATCH, DELETE, OPTIONS",
    );
  }

  // Handle preflight OPTIONS requests
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

// Serve static files (index.html, styles.css) from public directory
app.use(express.static(join(__dirname, "public")));

/* ============ Constants ============ */
// Session expiration time (sliding window)
// 30 minutes = 1800 seconds
const SESSION_TTL = 30 * 60;

// Device expiration time (persistent login)
// 90 days - allows "remember me" functionality
// Device survives browser close/reopen even if session expires
const DEVICE_TTL = 90 * 24 * 60 * 60; // 90 days in seconds

/* ============ Helper Functions ============ */
// Update device activity and refresh TTL
// Called on every request that has a device cookie
async function updateDeviceActivity(deviceId) {
  if (!deviceId) return;

  try {
    const deviceKey = `device:${deviceId}`;
    const deviceData = await redis.get(deviceKey);

    if (deviceData) {
      const device = JSON.parse(deviceData);
      device.lastSeenAt = new Date().toISOString();

      // Refresh device TTL (sliding window)
      await redis.set(deviceKey, JSON.stringify(device), "EX", DEVICE_TTL);
    }
  } catch (error) {
    console.error("Error updating device activity:", error);
    // Don't fail request if device update fails
  }
}

/* ============================================
   STEP 1: Create Anonymous Session
   ============================================ */
// POST /sessions - Create an anonymous session
// This is the entry point for new visitors
app.post("/sessions", async (req, res) => {
  try {
    // 1. Generate a cryptographically random session ID
    // UUIDv4 provides ~122 bits of entropy (collision probability: 1 in 5.3×10^36)
    const sessionId = uuidv4();

    // STEP 5: Check for existing device ID (persistent login)
    // Device cookie persists 90 days - survives browser close/session expiration
    let deviceId = req.signedCookies.did;
    let deviceData;
    let isNewDevice = false;

    if (!deviceId) {
      // No device cookie - this is a new device/browser
      deviceId = uuidv4();
      isNewDevice = true;

      // Create device record
      deviceData = {
        deviceId,
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        userAgent: req.get("user-agent") || "",
        // userId will be set later when user logs in (Step 6)
      };

      // Store device in Redis with 90-day TTL
      await redis.set(
        `device:${deviceId}`,
        JSON.stringify(deviceData),
        "EX",
        DEVICE_TTL,
      );
    } else {
      // Existing device - fetch and update lastSeenAt
      const existingDevice = await redis.get(`device:${deviceId}`);
      if (existingDevice) {
        deviceData = JSON.parse(existingDevice);
        deviceData.lastSeenAt = new Date().toISOString();

        // Refresh device TTL (sliding window for devices too)
        await redis.set(
          `device:${deviceId}`,
          JSON.stringify(deviceData),
          "EX",
          DEVICE_TTL,
        );
      } else {
        // Device cookie exists but not in Redis (expired or flushed)
        // Treat as new device
        isNewDevice = true;
        deviceData = {
          deviceId,
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          userAgent: req.get("user-agent") || "",
        };
        await redis.set(
          `device:${deviceId}`,
          JSON.stringify(deviceData),
          "EX",
          DEVICE_TTL,
        );
      }
    }

    // 2. Prepare session metadata
    // Start with minimal data - services will add more via attributes later
    const sessionData = {
      sessionId,
      deviceId, // Link session to device (Step 5)
      state: "anonymous", // Track authentication state (Step 6)
      createdAt: new Date().toISOString(), // When session was born
      lastSeenAt: new Date().toISOString(), // Last activity timestamp
      userAgent: req.get("user-agent") || "", // Browser/client info
      referrer: req.get("referer") || "", // Where they came from
      ip: req.ip || req.connection.remoteAddress || "", // Client IP for analytics
      attributes: {}, // Extensible storage (Step 4)
    };

    // 3. Store in Redis with TTL (30 minutes)
    // Key pattern: "session:{uuid}" makes it easy to find all sessions
    const redisKey = `session:${sessionId}`;

    // SET key value EX seconds - atomic operation that:
    //  - Writes the session data
    //  - Sets expiration in one command (no race condition)
    await redis.set(redisKey, JSON.stringify(sessionData), "EX", SESSION_TTL);

    // 4. Set cookies with security flags

    // Session cookie (short-lived, 30 minutes)
    res.cookie("sid", sessionId, {
      httpOnly: true, // Prevents JavaScript access (XSS protection)
      secure: false, // Set to true in production with HTTPS
      sameSite: "lax", // CSRF protection (won't send on cross-site POST)
      maxAge: SESSION_TTL * 1000, // Cookie expires with session (milliseconds)
      signed: true, // HMAC signature prevents tampering
    });

    // Device cookie (long-lived, 90 days) - STEP 5
    // Only set if this is a new device (don't reset expiration on existing)
    if (isNewDevice) {
      res.cookie("did", deviceId, {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        maxAge: DEVICE_TTL * 1000, // 90 days
        signed: true, // HMAC signature prevents tampering
      });
    }

    // 5. Return session info
    res.status(201).json({
      success: true,
      sessionId,
      deviceId,
      isNewDevice,
      state: sessionData.state,
      expiresIn: SESSION_TTL,
      deviceExpiresIn: DEVICE_TTL,
    });
  } catch (error) {
    console.error("Error creating session:", error);
    res.status(500).json({
      success: false,
      error: "Failed to create session",
    });
  }
});

/* ============================================
   STEP 2: Fetch Session (Read Path)
   + STEP 7: Auto-restore from Device Identity
   ============================================ */
// GET /sessions/me - Retrieve current session data
// Demonstrates low-latency lookup for cross-service retrieval
//
// STEP 7: If session expired but device has userId, automatically
// create a new authenticated session (persistent login)
app.get("/sessions/me", async (req, res) => {
  try {
    // 1. Read session ID from cookie
    // Browser automatically sends cookie with every request
    const sessionId = req.signedCookies.sid;
    const deviceId = req.signedCookies.did;

    // STEP 7: Session restoration logic
    // If no session cookie OR session expired, try to restore from device
    if (!sessionId || !(await redis.get(`session:${sessionId}`))) {
      // Check if we have a device cookie with user identity
      if (!deviceId) {
        return res.status(401).json({
          success: false,
          error: "No session or device cookie found",
          hint: "Create a new session with POST /sessions",
        });
      }

      // Fetch device record
      const deviceData = await redis.get(`device:${deviceId}`);
      if (!deviceData) {
        return res.status(401).json({
          success: false,
          error: "Device not found or expired",
          hint: "Create a new session with POST /sessions",
        });
      }

      const device = JSON.parse(deviceData);

      // Check if device has user identity attached
      if (!device.userId) {
        return res.status(401).json({
          success: false,
          error: "No session found and device is not authenticated",
          hint: "Session restoration requires an authenticated device. Use POST /sessions/me/attach-identity to attach a userId first.",
        });
      }

      // ✨ AUTO-RESTORE: Device has userId, create new authenticated session!
      const newSessionId = uuidv4();
      const now = new Date().toISOString();

      // Create restoration event (lineage tracking)
      const restorationEvent = {
        type: "RESTORE_FROM_DEVICE",
        at: now,
        parentDeviceId: deviceId,
        restoredUserId: device.userId,
        reason: "Session expired, restored from persistent device identity",
      };

      // Create new authenticated session
      const newSession = {
        sessionId: newSessionId,
        deviceId: deviceId,
        userId: device.userId, // Inherit from device!
        state: "authenticated", // Start as authenticated
        restoredFrom: deviceId, // Track that this was auto-restored
        createdAt: now,
        lastSeenAt: now,
        userAgent: req.get("user-agent") || "",
        referrer: req.get("referer") || "",
        ip: req.ip || req.connection.remoteAddress || "",
        attributes: {},
        events: [restorationEvent], // Record restoration event
      };

      // Store new session in Redis
      await redis.set(
        `session:${newSessionId}`,
        JSON.stringify(newSession),
        "EX",
        SESSION_TTL,
      );

      // Update device activity
      device.lastSeenAt = now;
      await redis.set(
        `device:${deviceId}`,
        JSON.stringify(device),
        "EX",
        DEVICE_TTL,
      );

      // Set new session cookie
      res.cookie("sid", newSessionId, {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        maxAge: SESSION_TTL * 1000,
        signed: true, // HMAC signature prevents tampering
      });

      // Return the newly restored session
      return res.json({
        success: true,
        session: newSession,
        restored: true, // Flag indicating this was auto-restored
        restorationEvent,
        latency: "0ms", // New session, no Redis read latency
      });
    }

    // Normal flow: Session exists
    // STEP 5: Update device activity in background
    if (deviceId) {
      updateDeviceActivity(deviceId); // Fire and forget
    }

    // 2. Fetch session from Redis (measure latency)
    const redisKey = `session:${sessionId}`;
    const startTime = Date.now();
    const sessionData = await redis.get(redisKey);
    const latency = Date.now() - startTime;

    if (!sessionData) {
      // Session expired - should have been caught above, but handle anyway
      return res.status(404).json({
        success: false,
        error: "Session not found or expired",
      });
    }

    // 3. Parse JSON and return session data
    const session = JSON.parse(sessionData);

    res.json({
      success: true,
      session,
      restored: false, // Not restored, existing session
      latency: `${latency}ms`, // Show read performance (~1-10ms typical)
    });
  } catch (error) {
    console.error("Error fetching session:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch session",
    });
  }
});

/* ============ Rate Limiting Middleware ============
 * PRODUCTION TODO: Implement rate limiting to prevent abuse
 *
 * Abuse Scenarios:
 *  1. Activity ping spam: Attacker floods POST /sessions/me/activity
 *     - Impact: Redis write load, potential DoS
 *     - Volume: Could send 1000s of requests per second
 *
 *  2. Session creation spam: Attacker creates unlimited anonymous sessions
 *     - Impact: Redis memory exhaustion, cookie bombardment
 *     - Volume: 100+ sessions per IP per minute
 *
 *  3. Brute force attacks: Attacker tries to guess session IDs or userIds
 *     - Impact: Security risk, Redis read load
 *     - Volume: Rapid sequential attempts
 *
 * Implementation Strategy (Redis-based):
 *  - Use Redis INCR + EXPIRE for atomic rate limit counters
 *  - Key pattern: ratelimit:{scope}:{identifier}
 *  - Sliding window or fixed window (trade-offs below)
 *
 * Example Implementation:
 *
 * async function rateLimitMiddleware(scope, limit, windowSec) {
 *   return async (req, res, next) => {
 *     const identifier = scope === 'ip' ? req.ip : req.signedCookies.sid;
 *     const key = `ratelimit:${scope}:${identifier}`;
 *
 *     // Atomic increment and get TTL
 *     const count = await redis.incr(key);
 *     if (count === 1) {
 *       await redis.expire(key, windowSec); // First request sets window
 *     }
 *
 *     if (count > limit) {
 *       return res.status(429).json({
 *         success: false,
 *         error: 'Rate limit exceeded',
 *         retryAfter: await redis.ttl(key),
 *       });
 *     }
 *
 *     next();
 *   };
 * }
 *
 * Apply to endpoints:
 *  app.post('/sessions/me/activity', rateLimitMiddleware('session', 60, 60), ...);
 *  app.post('/sessions', rateLimitMiddleware('ip', 10, 60), ...);
 *  app.post('/sessions/me/attach-identity', rateLimitMiddleware('ip', 5, 300), ...);
 *
 * Recommended Limits:
 *  - POST /sessions/me/activity: 60 per minute per session (1 req/sec)
 *  - POST /sessions: 10 per minute per IP (prevent session spam)
 *  - POST /sessions/me/attach-identity: 5 per 5 min per IP (brute force protection)
 *  - PATCH /sessions/me: 30 per minute per session
 *  - POST /sessions/merge: 5 per minute per session (expensive operation)
 *
 * Alternative: Use express-rate-limit with Redis store
 *  npm install express-rate-limit rate-limit-redis
 */

/* ============================================
   STEP 3: Sliding Window Expiration
   ============================================ */
// POST /sessions/me/activity - Update last activity timestamp
// Implements sliding window: session expires 30 min after LAST activity
//
// ⚠️ ABUSE RISK: This endpoint has no rate limiting in prototype
// Production: Add rate limit (60 req/min per session) to prevent Redis write spam
app.post("/sessions/me/activity", async (req, res) => {
  try {
    // 1. Read session ID from cookie
    const sessionId = req.signedCookies.sid;

    if (!sessionId) {
      return res.status(401).json({
        success: false,
        error: "No session cookie found",
      });
    }

    // STEP 5: Update device activity in background
    const deviceId = req.signedCookies.did;
    if (deviceId) {
      updateDeviceActivity(deviceId); // Fire and forget
    }

    // 2. Fetch current session from Redis
    const redisKey = `session:${sessionId}`;
    const sessionData = await redis.get(redisKey);

    if (!sessionData) {
      return res.status(404).json({
        success: false,
        error: "Session not found or expired",
      });
    }

    // 3. Update lastSeenAt timestamp
    const session = JSON.parse(sessionData);
    session.lastSeenAt = new Date().toISOString();

    // 4. Write back to Redis with FRESH TTL (sliding window!)
    // Key insight: Every activity ping resets the 30-minute countdown
    //
    // Example timeline:
    //  00:00 - Create session (expires at 00:30)
    //  00:25 - Ping activity (expires NOW at 00:55) ← reset!
    //  00:50 - Ping activity (expires NOW at 01:20) ← reset!
    //
    // Without pings: session expires 30 min after creation
    // With pings: session expires 30 min after LAST ping
    //
    // SET with EX is atomic - no race between update and TTL refresh
    //
    // PERFORMANCE NOTE (Prototype vs Production):
    // ============================================
    // Current: JSON blob with full rewrite
    //  - GET entire session JSON string
    //  - Parse JSON → object
    //  - Modify one field (lastSeenAt)
    //  - Stringify entire object → JSON
    //  - SET entire JSON string back to Redis
    //  - Cost: ~5KB write for changing 1 field (24 bytes)
    //  - At 10k req/sec: 50MB/sec write bandwidth
    //
    // Production Alternative: Redis Hashes (partial updates)
    //  - HSET session:{sid} lastSeenAt "2026-02-25T10:15:00Z"
    //  - EXPIRE session:{sid} 1800
    //  - Cost: 24 bytes write (200× reduction!)
    //  - At 10k req/sec: 240KB/sec write bandwidth
    //
    // Trade-offs:
    //  JSON Blob (current):
    //   ✅ Simple: One GET/SET operation
    //   ✅ Atomic: No partial state
    //   ✅ Easy serialization: JSON.stringify/parse
    //   ❌ Write amplification: Rewrite entire session on every ping
    //   ❌ Network inefficient: 5KB vs 24 bytes
    //   ❌ CPU cost: JSON parse/stringify on every operation
    //
    //  Redis Hash (production):
    //   ✅ Partial updates: Only write changed fields
    //   ✅ Network efficient: Write 24 bytes instead of 5KB
    //   ✅ CPU efficient: No JSON parse/stringify for field updates
    //   ❌ More complex: Multiple Redis commands (HSET/HGET/HGETALL)
    //   ❌ Nested attributes: Need JSON for "attributes" field
    //   ❌ Events/lineage: Need separate Redis list or JSON array
    //
    // Implementation Example (Redis Hash approach):
    //
    //   // Session storage as hash
    //   HSET session:{sid} userId "alice"
    //   HSET session:{sid} state "authenticated"
    //   HSET session:{sid} lastSeenAt "2026-02-25T10:15:00Z"
    //   HSET session:{sid} attributes '{"cart":["laptop"]}'  // Still JSON for nested
    //   RPUSH session:{sid}:events '{"type":"CREATED","at":"..."}'
    //
    //   // Activity ping becomes:
    //   await redis.hset(`session:${sessionId}`, 'lastSeenAt', new Date().toISOString());
    //   await redis.expire(`session:${sessionId}`, SESSION_TTL);
    //
    // Additional Production Optimizations:
    //  1. Cap lineage length: events.push() → if (events.length > 50) events.shift()
    //  2. Separate hot vs cold: Store lastSeenAt in separate key with shorter TTL
    //  3. Use pipeline: Multi-command operations in single round-trip
    //
    // When to migrate:
    //  - Prototype: JSON blob is fine (1-10k req/sec)
    //  - 10k+ req/sec: Consider Redis Hashes
    //  - 50k+ req/sec: Must use Redis Hashes + optimization
    //
    await redis.set(redisKey, JSON.stringify(session), "EX", SESSION_TTL);

    res.json({
      success: true,
      message: "Activity updated, session TTL refreshed",
      ttlSeconds: SESSION_TTL,
      lastSeenAt: session.lastSeenAt,
    });
  } catch (error) {
    console.error("Error updating activity:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update activity",
    });
  }
});

/* ============================================
   STEP 4: Extensible Attributes
   ============================================ */
// PATCH /sessions/me - Attach custom metadata to session
// Allows different services to add their own tracking data safely
//
// Use cases:
//  - Marketing: { campaignId, utmSource, referralSource }
//  - A/B testing: { experimentId, variantId }
//  - Analytics: { locale, deviceType, appVersion }
//
// Why this matters:
//  Instead of each service creating its own tracking system,
//  they all share ONE session and attach their metadata as attributes.
app.patch("/sessions/me", async (req, res) => {
  try {
    // 1. Read session ID from cookie
    const sessionId = req.signedCookies.sid;

    if (!sessionId) {
      return res.status(401).json({
        success: false,
        error: "No session cookie found",
      });
    }

    // STEP 5: Update device activity in background
    const deviceId = req.signedCookies.did;
    if (deviceId) {
      updateDeviceActivity(deviceId); // Fire and forget
    }

    // 2. Validate the request body
    const { attributes } = req.body;

    if (!attributes || typeof attributes !== "object") {
      return res.status(400).json({
        success: false,
        error: "Request must include 'attributes' object",
      });
    }

    // ========== Validation Rules ==========

    // Rule 1: Size limit - prevent storing huge objects
    //
    // Why: Without this, a service could accidentally store a 10MB JSON:
    //  - Fills up Redis memory
    //  - Slows down reads/writes
    //  - Can be used for DoS attacks
    //
    // 10KB is enough for typical metadata but prevents abuse
    const attributesString = JSON.stringify(attributes);
    const MAX_ATTRIBUTES_SIZE = 10 * 1024; // 10KB limit

    if (attributesString.length > MAX_ATTRIBUTES_SIZE) {
      return res.status(400).json({
        success: false,
        error: `Attributes too large. Max size: ${MAX_ATTRIBUTES_SIZE} bytes`,
      });
    }

    // Rule 2: Allowed keys - define what metadata we accept
    //
    // Why whitelist instead of blacklist:
    //  ✅ Prevents storing sensitive data (passwords, credit cards)
    //  ✅ Creates a clear contract across services
    //  ✅ Makes debugging easier (you know what to expect)
    //  ✅ Prevents random data pollution
    //
    // If you need a new key, add it here and redeploy
    const ALLOWED_KEYS = [
      "campaignId", // Marketing campaigns
      "cart", // Shopping cart contents (e.g., [{ productId, quantity }])
      "referralSource", // Where user came from
      "utmSource", // UTM tracking params
      "utmMedium",
      "utmCampaign",
      "experimentId", // A/B testing
      "variantId",
      "locale", // User language/region (e.g., "en-US")
      "deviceType", // mobile/desktop/tablet
      "appVersion", // Client app version
    ];

    const invalidKeys = Object.keys(attributes).filter(
      (key) => !ALLOWED_KEYS.includes(key),
    );

    if (invalidKeys.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Invalid attribute keys: ${invalidKeys.join(", ")}`,
        allowedKeys: ALLOWED_KEYS,
      });
    }

    // 3. Fetch current session from Redis
    const redisKey = `session:${sessionId}`;
    const sessionData = await redis.get(redisKey);

    if (!sessionData) {
      return res.status(404).json({
        success: false,
        error: "Session not found or expired",
      });
    }

    // 4. Parse session and MERGE attributes (critical: don't replace!)
    const session = JSON.parse(sessionData);

    // MERGE behavior explained:
    //
    // Before: session.attributes = { locale: "en-US" }
    // Request: { campaignId: "summer", utmSource: "google" }
    // After:  session.attributes = { locale: "en-US", campaignId: "summer", utmSource: "google" }
    //                                  ↑ KEPT!         ↑ ADDED          ↑ ADDED
    //
    // Why merge instead of replace:
    //  - Service A might set { campaignId }
    //  - Service B might set { locale }
    //  - Both need to coexist!
    //  - If we replaced, Service B would wipe out Service A's data
    //
    // Spread operator (...) does a shallow merge (left-to-right)
    session.attributes = {
      ...session.attributes, // Keep existing attributes
      ...attributes, // Add/overwrite with new attributes
    };

    // Update lastSeenAt (tracks when session was last modified)
    session.lastSeenAt = new Date().toISOString();

    // 5. Write back to Redis with fresh TTL (sliding window behavior)
    //
    // Why refresh TTL here:
    //  - Updating metadata counts as "activity"
    //  - Keeps session alive as long as services are using it
    //  - Consistent with Step 3 sliding window behavior
    //
    // SET is atomic - write data + set TTL in one operation
    await redis.set(redisKey, JSON.stringify(session), "EX", SESSION_TTL);

    res.json({
      success: true,
      message: "Session attributes updated",
      attributes: session.attributes, // Return merged result
      ttlSeconds: SESSION_TTL,
    });
  } catch (error) {
    console.error("Error updating session attributes:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update session attributes",
    });
  }
});

/* ============================================
   STEP 6: Attach Identity on Login
   ============================================ */
// POST /sessions/me/attach-identity - Transition from anonymous to authenticated
// Tracks the anonymous → authenticated migration and establishes persistent user identity
//
// Use cases:
//  - User signs up or logs in for the first time on this device
//  - Links their userId to both the current session and the device
//  - Future sessions from this device can automatically restore userId
//
// Why this matters:
//  - Session cookies expire (30 min), but device cookies persist (90 days)
//  - When session expires, new session can inherit userId from device
//  - Enables "stay logged in" without infinite session tokens
//  - Creates audit trail of identity transitions
app.post("/sessions/me/attach-identity", async (req, res) => {
  try {
    // 1. Read session and device IDs from cookies
    const sessionId = req.signedCookies.sid;
    const deviceId = req.signedCookies.did;

    if (!sessionId) {
      return res.status(401).json({
        success: false,
        error: "No session cookie found",
      });
    }

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        error: "No device cookie found - cannot attach identity",
      });
    }

    // 2. Validate request body
    const { userId } = req.body;

    if (!userId || typeof userId !== "string") {
      return res.status(400).json({
        success: false,
        error: "Request must include 'userId' string (mock auth for local)",
      });
    }

    // 3. Fetch current session
    const sessionKey = `session:${sessionId}`;
    const sessionData = await redis.get(sessionKey);

    if (!sessionData) {
      return res.status(404).json({
        success: false,
        error: "Session not found or expired",
      });
    }

    const session = JSON.parse(sessionData);
    const previousState = session.state;

    // 4. Fetch device record
    const deviceKey = `device:${deviceId}`;
    const deviceData = await redis.get(deviceKey);

    if (!deviceData) {
      return res.status(404).json({
        success: false,
        error: "Device not found or expired",
      });
    }

    const device = JSON.parse(deviceData);

    // STEP 10: Session Rotation (Session Fixation Mitigation)
    // When user authenticates, ROTATE the session ID to prevent session fixation attacks
    // Attack scenario without rotation:
    //   1. Attacker creates session: sid=ATTACKER_CONTROLLED_ID
    //   2. Attacker tricks victim into using that session (phishing link, XSS, etc.)
    //   3. Victim logs in with that session
    //   4. Attacker now has access to victim's authenticated session!
    //
    // Mitigation: Generate NEW session ID on privilege escalation (login)
    const newSessionId = uuidv4(); // Fresh ID that attacker doesn't know
    const now = new Date().toISOString();

    // 5. Create migration event (lineage tracking)
    const migrationEvent = {
      type: "ANON_TO_AUTH",
      at: now,
      fromSessionId: sessionId,
      fromState: previousState,
      toState: "authenticated",
      userId,
      deviceId,
    };

    // 6. Create rotation event (security audit trail)
    const rotationEvent = {
      type: "ROTATE",
      at: now,
      fromSid: sessionId, // Old session ID (potentially compromised)
      toSid: newSessionId, // New session ID (safe)
      reason: "Session rotated on privilege escalation (login)",
      userId,
    };

    // 7. Create NEW session with rotated ID
    // Copy forward "safe" data from old session
    const newSession = {
      sessionId: newSessionId, // ← NEW ID!
      deviceId: session.deviceId, // Keep same device
      userId, // Attach user identity
      state: "authenticated",
      authAt: now,
      createdAt: now, // New session creation time
      lastSeenAt: now,
      userAgent: session.userAgent,
      referrer: session.referrer,
      ip: session.ip,
      // Copy forward safe attributes (e.g., cart, campaign tracking)
      // Don't copy sensitive/temporary data
      attributes: { ...session.attributes },
      // Preserve lineage history + add migration + rotation events
      events: [...(session.events || []), migrationEvent, rotationEvent].slice(
        -10,
      ), // Cap at 10 most recent
    };

    // 8. Update device - attach identity
    // This is KEY for persistent login:
    // When session expires and user returns, new session can inherit
    // userId from device record
    device.userId = userId;
    device.lastSeenAt = now;

    // STEP 8: Multi-device behavior
    // Add this device to the user's device set
    const userDevicesKey = `user:${userId}:devices`;

    // 9. Write new session, update device, invalidate old session atomically
    const newSessionKey = `session:${newSessionId}`;
    const oldSessionKey = `session:${sessionId}`;

    await Promise.all([
      // Create new session with rotated ID
      redis.set(newSessionKey, JSON.stringify(newSession), "EX", SESSION_TTL),
      // Update device
      redis.set(deviceKey, JSON.stringify(device), "EX", DEVICE_TTL),
      // Add device to user's device set
      redis.sadd(userDevicesKey, deviceId),
      // Invalidate old session (delete it - attacker's session is now useless!)
      redis.del(oldSessionKey),
    ]);

    // 10. Set NEW session cookie (replaces old one)
    // This is critical - browser now sends new ID on future requests
    res.cookie("sid", newSessionId, {
      httpOnly: true,
      secure: false, // Set to true in production with HTTPS
      sameSite: "lax",
      maxAge: SESSION_TTL * 1000,
      signed: true, // HMAC signature prevents tampering
    });

    // 11. Return updated session info
    res.json({
      success: true,
      message: "Identity attached and session rotated for security",
      session: {
        sessionId: newSession.sessionId, // ← NEW ID!
        deviceId: newSession.deviceId,
        userId: newSession.userId,
        state: newSession.state,
        authAt: newSession.authAt,
        previousState,
      },
      device: {
        deviceId: device.deviceId,
        userId: device.userId,
        createdAt: device.createdAt,
      },
      migrationEvent,
      rotationEvent, // Include rotation event in response
      security: {
        oldSessionId: sessionId, // For debugging/audit
        newSessionId: newSessionId,
        rotated: true,
        reason: "Session fixation mitigation on privilege escalation",
      },
    });
  } catch (error) {
    console.error("Error attaching identity:", error);
    res.status(500).json({
      success: false,
      error: "Failed to attach identity",
    });
  }
});

/* ============================================
   STEP 8: List User Devices
   ============================================ */
// GET /users/me/devices - List all devices for current user
// Shows multi-device behavior - same user logged in from multiple browsers/devices
app.get("/users/me/devices", async (req, res) => {
  try {
    // 1. Get current session to find userId
    const sessionId = req.signedCookies.sid;

    if (!sessionId) {
      return res.status(401).json({
        success: false,
        error: "No session cookie found",
      });
    }

    const sessionData = await redis.get(`session:${sessionId}`);
    if (!sessionData) {
      return res.status(404).json({
        success: false,
        error: "Session not found or expired",
      });
    }

    const session = JSON.parse(sessionData);

    if (!session.userId) {
      return res.status(400).json({
        success: false,
        error: "Session is not authenticated - no userId found",
        hint: "Attach identity first with POST /sessions/me/attach-identity",
      });
    }

    // 2. Get all device IDs for this user
    const userDevicesKey = `user:${session.userId}:devices`;
    const deviceIds = await redis.smembers(userDevicesKey);

    if (deviceIds.length === 0) {
      return res.json({
        success: true,
        userId: session.userId,
        devices: [],
        count: 0,
        message: "No devices found for this user",
      });
    }

    // 3. Fetch details for each device
    const devicePromises = deviceIds.map(async (deviceId) => {
      const deviceData = await redis.get(`device:${deviceId}`);
      if (!deviceData) {
        // Device expired or deleted
        return null;
      }
      const device = JSON.parse(deviceData);
      return {
        deviceId: device.deviceId,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        userAgent: device.userAgent,
        isCurrent: device.deviceId === req.signedCookies.did,
      };
    });

    const devices = (await Promise.all(devicePromises)).filter(
      (d) => d !== null,
    );

    // 4. Clean up stale device IDs from the set
    const staleDeviceIds = deviceIds.filter(
      (id) => !devices.find((d) => d.deviceId === id),
    );
    if (staleDeviceIds.length > 0) {
      await redis.srem(userDevicesKey, ...staleDeviceIds);
    }

    res.json({
      success: true,
      userId: session.userId,
      devices,
      count: devices.length,
    });
  } catch (error) {
    console.error("Error fetching user devices:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch user devices",
    });
  }
});

/* ============================================
   STEP 9: Session Merge
   ============================================ */
// POST /sessions/merge - Merge two sessions into one
// Handles "local merge" scenario: anonymous session + authenticated session → one session
// Use cases: user browses anonymously, logs in, we merge shopping cart/analytics/etc.
app.post("/sessions/merge", async (req, res) => {
  try {
    const { sourceSessionId, targetSessionId } = req.body;

    // 1. Validate input
    if (!sourceSessionId || !targetSessionId) {
      return res.status(400).json({
        success: false,
        error: "Both sourceSessionId and targetSessionId are required",
      });
    }

    if (sourceSessionId === targetSessionId) {
      return res.status(400).json({
        success: false,
        error: "Cannot merge a session with itself",
      });
    }

    // 2. Fetch both sessions
    const sourceData = await redis.get(`session:${sourceSessionId}`);
    const targetData = await redis.get(`session:${targetSessionId}`);

    if (!sourceData) {
      return res.status(404).json({
        success: false,
        error: "Source session not found or expired",
      });
    }

    if (!targetData) {
      return res.status(404).json({
        success: false,
        error: "Target session not found or expired",
      });
    }

    const sourceSession = JSON.parse(sourceData);
    const targetSession = JSON.parse(targetData);

    // 3. Apply merge rules
    const mergedSession = {
      ...targetSession, // Start with target as base
    };

    // Rule 1: Target wins for userId if set
    // (already in mergedSession from spread above)

    // Rule 2: Merge attributes - target overrides collisions
    mergedSession.attributes = {
      ...sourceSession.attributes, // Source attributes first
      ...targetSession.attributes, // Target overrides on collision
    };

    // Rule 3: Append MERGE event to lineage
    const mergeEvent = {
      type: "MERGE",
      from: sourceSessionId,
      to: targetSessionId,
      at: new Date().toISOString(),
      sourceUserId: sourceSession.userId || null,
      targetUserId: targetSession.userId || null,
    };

    mergedSession.lineage = [
      ...(sourceSession.lineage || []), // Include source history
      ...(targetSession.lineage || []), // Include target history
      mergeEvent, // Add merge event
    ];

    // Update timestamp to preserve target's creation time
    mergedSession.updatedAt = new Date().toISOString();

    // 4. Save merged session
    const targetKey = `session:${targetSessionId}`;
    await redis.set(
      targetKey,
      JSON.stringify(mergedSession),
      "EX",
      SESSION_TTL,
    );

    // 5. Invalidate source session - mark it as merged
    const sourceKey = `session:${sourceSessionId}`;
    const mergedMarker = {
      ...sourceSession,
      mergedInto: targetSessionId,
      mergedAt: new Date().toISOString(),
      invalidated: true,
    };
    // Set short TTL (5 min) so it's briefly queryable for audit, then auto-expires
    await redis.set(sourceKey, JSON.stringify(mergedMarker), "EX", 300);

    res.json({
      success: true,
      message: "Sessions merged successfully",
      targetSessionId,
      mergedSession: {
        sessionId: mergedSession.sessionId,
        userId: mergedSession.userId,
        deviceId: mergedSession.deviceId,
        attributes: mergedSession.attributes,
        lineage: mergedSession.lineage,
        createdAt: mergedSession.createdAt,
        updatedAt: mergedSession.updatedAt,
      },
      sourceSessionId,
      sourceStatus: "invalidated (merged into target)",
    });
  } catch (error) {
    console.error("Error merging sessions:", error);
    res.status(500).json({
      success: false,
      error: "Failed to merge sessions",
    });
  }
});

/* ============================================
   Testing & Debug Endpoints
   ============================================ */
// DELETE /sessions/me - Delete current session from Redis
// Used for testing Step 7 restoration logic
app.delete("/sessions/me", async (req, res) => {
  try {
    const sessionId = req.signedCookies.sid;

    if (!sessionId) {
      return res.status(401).json({
        success: false,
        error: "No session cookie found",
      });
    }

    // Delete session from Redis
    const redisKey = `session:${sessionId}`;
    const deleted = await redis.del(redisKey);

    if (deleted === 0) {
      return res.status(404).json({
        success: false,
        error: "Session not found in Redis",
      });
    }

    res.json({
      success: true,
      message: "Session deleted from Redis",
      sessionId,
      note: "Cookie still exists in browser - use this to test restoration",
    });
  } catch (error) {
    console.error("Error deleting session:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete session",
    });
  }
});

// POST /debug/clear-session-cookie - Clear session cookie from browser
// DEV/DEMO ONLY: Allows testing httpOnly cookie deletion from UI
//
// Problem:
//  - Production cookies use httpOnly:true (prevents XSS)
//  - But document.cookie in JavaScript can't delete httpOnly cookies
//  - Testing restoration flow requires clearing sid cookie
//
// Solution:
//  - Server-side endpoint that calls res.clearCookie()
//  - Browser UI can trigger cookie deletion by calling this endpoint
//  - In production, remove this endpoint or protect with auth
app.post("/debug/clear-session-cookie", async (req, res) => {
  try {
    // Clear the session cookie (server-side operation)
    res.clearCookie("sid", {
      httpOnly: true,
      secure: false, // Match the cookie settings
      sameSite: "lax",
      signed: true, // Important: must match the original cookie settings
    });

    res.json({
      success: true,
      message: "Session cookie cleared from browser",
      note: "This is a dev/demo endpoint - httpOnly cookies cannot be deleted from JavaScript",
    });
  } catch (error) {
    console.error("Error clearing session cookie:", error);
    res.status(500).json({
      success: false,
      error: "Failed to clear session cookie",
    });
  }
});

/* ============================================
   STEP 10: Session Invalidation
   ============================================ */
// POST /sessions/me/invalidate - Invalidate current session and clear cookie
// Security: Allows user to explicitly log out and destroy session
// Use cases: Logout button, "Sign out everywhere" functionality
app.post("/sessions/me/invalidate", async (req, res) => {
  try {
    const sessionId = req.signedCookies.sid;

    if (!sessionId) {
      return res.status(401).json({
        success: false,
        error: "No session cookie found",
      });
    }

    // Delete session from Redis
    const redisKey = `session:${sessionId}`;
    const deleted = await redis.del(redisKey);

    // Clear session cookie (set to expire immediately)
    res.clearCookie("sid", {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
    });

    if (deleted === 0) {
      // Session already expired/deleted, but still clear cookie
      return res.json({
        success: true,
        message: "Session not found in Redis, but cookie cleared",
        sessionId,
        note: "Session may have already expired",
      });
    }

    res.json({
      success: true,
      message: "Session invalidated successfully",
      sessionId,
      note: "Cookie cleared - user is fully logged out",
    });
  } catch (error) {
    console.error("Error invalidating session:", error);
    res.status(500).json({
      success: false,
      error: "Failed to invalidate session",
    });
  }
});

/* ============================================
   STEP 11: Internal Cross-Service Endpoint
   ============================================ */
// GET /internal/sessions/:sid - Retrieve session for internal services
// Protected by shared secret header (not for public use)
//
// Why this endpoint:
//  - Other services (email, billing, analytics) need to read session data
//  - Can't give them direct Redis access (security, coupling)
//  - Can't use cookie-based auth (services don't have user's cookies)
//  - Solution: Internal endpoint with shared secret authentication
//
// Usage:
//  Service B → GET /internal/sessions/{sid} with X-Internal-Secret header
//  Session Service → Returns session data if secret matches

// PUBLIC DEMO ENDPOINT: Proxy to internal endpoint for UI testing
// GET /sessions/:sid/demo-internal - Demo cross-service access (no secret required)
// This allows the browser UI to test STEP 12 without exposing INTERNAL_API_SECRET
// In production, remove this endpoint - only real services should use /internal/*
app.get("/sessions/:sid/demo-internal", async (req, res) => {
  try {
    const { sid } = req.params;

    if (!sid) {
      return res.status(400).json({
        success: false,
        error: "Session ID required in URL path",
      });
    }

    // Fetch session from Redis (same logic as internal endpoint)
    const redisKey = `session:${sid}`;
    const sessionData = await redis.get(redisKey);

    if (!sessionData) {
      return res.status(404).json({
        success: false,
        error: "Session not found or expired",
        sessionId: sid,
      });
    }

    const session = JSON.parse(sessionData);

    res.json({
      success: true,
      session,
      source: "session-service",
      note: "Demo endpoint - simulates internal cross-service call (no secret required)",
    });
  } catch (error) {
    console.error("Error in demo internal endpoint:", error);
    res.status(500).json({
      success: false,
      error: "Failed to retrieve session",
    });
  }
});

// PRODUCTION ENDPOINT: Real internal endpoint with secret authentication
app.get("/internal/sessions/:sid", async (req, res) => {
  try {
    // 1. Verify internal authentication
    // Shared secret prevents unauthorized access from outside services
    const providedSecret = req.headers["x-internal-secret"];

    if (!providedSecret || providedSecret !== INTERNAL_API_SECRET) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized - Invalid or missing X-Internal-Secret header",
        hint: "This endpoint is for internal service-to-service communication only",
      });
    }

    // 2. Get session ID from URL parameter
    const { sid } = req.params;

    if (!sid) {
      return res.status(400).json({
        success: false,
        error: "Session ID required in URL path",
      });
    }

    // 3. Fetch session from Redis
    const redisKey = `session:${sid}`;
    const sessionData = await redis.get(redisKey);

    if (!sessionData) {
      return res.status(404).json({
        success: false,
        error: "Session not found or expired",
        sessionId: sid,
      });
    }

    // 4. Return session data
    const session = JSON.parse(sessionData);

    res.json({
      success: true,
      session,
      source: "session-service",
      note: "Internal endpoint - session retrieved for cross-service use",
    });
  } catch (error) {
    console.error("Error retrieving session for internal service:", error);
    res.status(500).json({
      success: false,
      error: "Failed to retrieve session",
    });
  }
});

/* ============ Health Check ============ */
// GET /health - Check if service and Redis are alive
app.get("/health", async (req, res) => {
  try {
    await redis.ping();
    res.json({ status: "healthy", redis: "connected" });
  } catch (error) {
    res.status(503).json({ status: "unhealthy", redis: "disconnected" });
  }
});

/* ============ Server Lifecycle ============ */
// Start server
app.listen(PORT, () => {
  console.log(`Session service running on http://localhost:${PORT}`);
  console.log(`Redis URL: ${process.env.REDIS_URL}`);
});

// Graceful shutdown on SIGTERM
// Ensures Redis connections close cleanly
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing connections...");
  await redis.quit();
  process.exit(0);
});
