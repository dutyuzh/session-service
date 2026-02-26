/* ======================================
   Service B - Email/Notification Service
   ====================================== */

// Simulates a separate microservice that needs session data
// Could be: email service, billing, analytics, recommendation engine, etc.

import "dotenv/config";

// Configuration
const SESSION_SERVICE_URL =
  process.env.SESSION_SERVICE_URL || "http://localhost:3000";
const INTERNAL_API_SECRET =
  process.env.INTERNAL_API_SECRET || "dev-secret-change-in-prod";

/* ============================================
   Business Logic - Email Service Example
   ============================================ */

/**
 * Get session data from session service
 * This is how Service B retrieves shared session state
 */
async function getSessionFromSessionService(sessionId) {
  try {
    const response = await fetch(
      `${SESSION_SERVICE_URL}/internal/sessions/${sessionId}`,
      {
        method: "GET",
        headers: {
          "X-Internal-Secret": INTERNAL_API_SECRET,
          "Content-Type": "application/json",
        },
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Session service error: ${error.error}`);
    }

    const data = await response.json();
    return data.session;
  } catch (error) {
    console.error(
      "Failed to fetch session from session service:",
      error.message,
    );
    throw error;
  }
}

/**
 * Send personalized email based on session data
 * Example business logic that uses cross-service session continuity
 */
async function sendPersonalizedEmail(sessionId) {
  console.log("\n🔔 Service B: Email Service");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  try {
    // 1. Retrieve session from Session Service
    console.log(`📡 Fetching session ${sessionId} from Session Service...`);
    const session = await getSessionFromSessionService(sessionId);

    // 2. Extract user information
    const { userId, attributes, state, createdAt } = session;

    console.log(`✅ Session retrieved successfully!`);
    console.log(`   User ID: ${userId || "anonymous"}`);
    console.log(`   State: ${state}`);
    console.log(`   Attributes:`, JSON.stringify(attributes, null, 2));

    // 3. Business logic based on session data
    if (userId) {
      // Authenticated user - send personalized email
      console.log(`\n📧 Sending personalized email to user ${userId}...`);

      // Example: Cart abandonment email
      if (attributes.cart && Array.isArray(attributes.cart) && attributes.cart.length > 0) {
        console.log(`   📦 Cart items detected: ${attributes.cart.join(", ")}`);
        console.log(`   ✉️  Email type: Cart Abandonment Reminder`);
        console.log(
          `   💡 Message: "Hey! You left ${attributes.cart.length} items in your cart!"`,
        );
      }
      // Example: Campaign-specific email
      else if (attributes.campaignId) {
        console.log(`   🎯 Campaign detected: ${attributes.campaignId}`);
        console.log(`   ✉️  Email type: Campaign Follow-up`);
        console.log(
          `   💡 Message: "Thanks for visiting from ${attributes.campaignId}!"`,
        );
      }
      // Example: Generic welcome email
      else {
        console.log(`   ✉️  Email type: Welcome Back`);
        console.log(`   💡 Message: "Welcome back, ${userId}!"`);
      }

      console.log(`   ✅ Email queued successfully`);
    } else {
      // Anonymous user - collect as lead
      console.log(`\n👤 Anonymous user - collecting lead information...`);
      console.log(
        `   🕐 Session age: ${Math.floor((Date.now() - new Date(createdAt)) / 1000 / 60)} minutes`,
      );
      console.log(`   📊 UTM source: ${attributes.utmSource || "direct"}`);
      console.log(`   💡 Action: Trigger "Sign up and save 10%" popup`);
    }

    console.log(`\n✨ Service B completed successfully!`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    return {
      success: true,
      userId,
      emailSent: !!userId,
      attributes,
    };
  } catch (error) {
    console.error(`❌ Service B error: ${error.message}`);
    throw error;
  }
}

/* ============================================
   CLI Interface
   ============================================ */

// Allow running from command line
if (process.argv.length > 2) {
  const sessionId = process.argv[2];

  console.log(`\n🚀 Starting Service B with session ID: ${sessionId}`);

  sendPersonalizedEmail(sessionId)
    .then((result) => {
      console.log("Result:", result);
      process.exit(0);
    })
    .catch((error) => {
      console.error("Fatal error:", error.message);
      process.exit(1);
    });
}

/* ============================================
   Export for programmatic use
   ============================================ */

export { getSessionFromSessionService, sendPersonalizedEmail };
