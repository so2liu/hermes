/**
 * Integration test: verifies WebSocket skill registration and exec callback.
 * Does NOT require an LLM API key.
 *
 * Tests:
 * 1. Client connects and registers a skill
 * 2. Server creates exec tool and invokes it
 * 3. Client receives exec request and sends result back
 * 4. Server receives the result
 * 5. Client disconnects → skill is unregistered
 *
 * This test uses SkillRegistry directly (no LLM agent).
 * See test-skill-ws.ts for the full implementation.
 */

// Re-export the skill WebSocket test
import "./test-skill-ws";
