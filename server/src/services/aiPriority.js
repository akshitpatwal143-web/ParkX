/**
 * ParkX Phase 3.5: AI Message Priority Classification Service
 *
 * Classifies visitor message intent and urgency into 4 levels:
 * - URGENT: Blocking emergency vehicles/routes, medical emergency, immediate towing risk, fire hazard.
 * - HIGH: Blocking driveway or another car, vehicle alarm sounding, lights left on, open window in rain.
 * - NORMAL: General parking coordination, return time inquiry, spot coordination.
 * - LOW: Compliments, casual notes, non-actionable remarks.
 *
 * Guarantees:
 * - Never drops, modifies, or discards messages.
 * - Asynchronous/non-blocking to ensure message delivery is never delayed.
 * - Safe fallback to NORMAL if AI service is unconfigured, unreachable, or errors.
 * - Strict backend validation and output constraining.
 * - Never logs or leaks secrets (API keys) or sensitive tokens.
 * - PII redaction ensures visitor privacy before calling external classification.
 * - Concurrency-safe priority aggregation: delayed classifications never overwrite higher-priority or manual overrides.
 */

export const PRIORITY_LEVELS = Object.freeze(['urgent', 'high', 'normal', 'low']);

export const PRIORITY_RANKS = Object.freeze({
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
});

export const DEFAULT_AI_MODEL = 'gemini-3.8-flash';

let testClassifier = null;

export function setAiClassifierForTesting(classifierFn) {
  testClassifier = classifierFn;
}

export function resetAiClassifierForTesting() {
  testClassifier = null;
}

/**
 * Safe, allowed parking and conversational vocabulary for fail-closed verification.
 * Words here are permitted when capitalized in visitor messages.
 */
const ALLOWED_CAPITALIZED_WORDS = new Set([
  'I', "I'M", "I'LL", "I'D", "I'VE",
  'A', 'AN', 'THE', 'THIS', 'THAT', 'THESE', 'THOSE',
  'PLEASE', 'THANK', 'THANKS', 'HELLO', 'HI', 'HEY', 'GOOD',
  'URGENT', 'EMERGENCY', 'AMBULANCE', 'FIRE', 'POLICE', 'TOW', 'TOWING', 'HOSPITAL',
  'CAR', 'VEHICLE', 'TRUCK', 'VAN', 'SUV', 'EV', 'PARKING', 'SPOT', 'DRIVEWAY', 'GARAGE',
  'BLOCK', 'BLOCKED', 'BLOCKING', 'MOVE', 'MOVING', 'LEAVE', 'LEAVING',
  'ALARM', 'LIGHTS', 'WINDOW', 'DOOR', 'TIRE', 'TYRE',
  'OK', 'YES', 'NO', 'SOON', 'NOW', 'ASAP', 'TODAY', 'MINUTES', 'HOURS',
  'CAN', 'COULD', 'WOULD', 'YOU', 'YOUR', 'MY', 'OUR', 'IS', 'ARE', 'THERE',
  'SORRY', 'EXCUSE', 'NEED', 'JUST', 'WHAT', 'WHEN', 'WHERE', 'HOW',
  'AM', 'PM',
  'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY',
  'NAME', 'VEHICLE_REGISTRATION', 'ADDRESS', 'PHONE', 'EMAIL', 'IDENTIFIER', 'LINK',
]);

/**
 * Redacts personal identifying information (PII) before external AI processing.
 * Removes vehicle registrations, addresses, names, phone numbers, emails, URLs, and numeric identifiers.
 */
export function redactPiiForAi(text) {
  if (typeof text !== 'string') return '';
  let sanitized = text;

  // 1. Redact email addresses
  sanitized = sanitized.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi, '[EMAIL]');

  // 2. Redact URLs and web links
  sanitized = sanitized.replace(/\b(?:https?:\/\/|www\.)\S+\b/gi, '[LINK]');

  // 3. Redact potential structured identifiers (e.g. 12-digit Aadhaar, 16-digit credit card, SSN)
  sanitized = sanitized.replace(/\b(?:\d{4}[-\s]){2,3}\d{4}\b/g, '[IDENTIFIER]');
  sanitized = sanitized.replace(/\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g, '[IDENTIFIER]');

  // 4. Redact phone numbers (runs before plates/addresses so numbers like (555) 123-4567 are not split)
  sanitized = sanitized.replace(/(?:(?:\+|00)\d{1,4}[-.\s]*)?(?:\(?\d{2,5}\)?[-.\s]*)?\d{3,5}[-.\s]*\d{3,5}\b/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length <= 15) {
      return '[PHONE]';
    }
    return match;
  });

  // 5. Redact street addresses, house numbers, sectors, and roads (runs before plates so address digits are preserved as address)
  // 5a. House/building numbers with letters + street name (e.g. "12B Oak St.", "42 Main Road", "101-A Park Ave")
  sanitized = sanitized.replace(/\b\d+[a-zA-Z]?(?:[-\s]\d+)?[-\s,]+(?:[A-Za-z0-9\s,.-]+?\s+)?(?:street\b|st\.?\b|road\b|rd\.?\b|avenue\b|ave\.?\b|lane\b|ln\.?\b|drive\b|dr\.?\b|boulevard\b|blvd\.?\b|way\b|circle\b|cir\.?\b|court\b|ct\.?\b|place\b|pl\.?\b|terrace\b|terr\.?\b|sector\b|sec\.?\b|block\b|blk\.?\b|nagar\b|colony\b|enclave\b|vihar\b|marg\b|cross\b|main\b)/gi, '[ADDRESS]');

  // 5b. Named housing units (e.g. "Flat 402, Lotus Court", "Plot 12, Main St")
  sanitized = sanitized.replace(/\b(?:(?:flat|apt|apartment|house|plot|door|room|suite|h\.?\s*no\.?)\s*#?\s*\d+[a-zA-Z]?(?:[-\s]\d+)?)[,\s]+[A-Za-z0-9\s,.-]+?\s+(?:street\b|st\.?\b|road\b|rd\.?\b|avenue\b|ave\.?\b|lane\b|ln\.?\b|drive\b|dr\.?\b|boulevard\b|blvd\.?\b|way\b|circle\b|cir\.?\b|court\b|ct\.?\b|place\b|pl\.?\b|terrace\b|terr\.?\b|sector\b|sec\.?\b|block\b|blk\.?\b|nagar\b|colony\b|enclave\b|vihar\b|marg\b|cross\b|main\b)/gi, '[ADDRESS]');

  // 5c. Preposition + location / street name (e.g. "at 12B Oak St.", "at Oak St", "on Elm Road", "near 5th Ave")
  sanitized = sanitized.replace(/\b(?:at|on|near|in|opp(?:osite)?|beside|behind|front\s+of)\s+(?:\d+[a-zA-Z]?[-\s,]+)?[A-Za-z0-9\s,.-]+?\s+(?:street\b|st\.?\b|road\b|rd\.?\b|avenue\b|ave\.?\b|lane\b|ln\.?\b|drive\b|dr\.?\b|boulevard\b|blvd\.?\b|way\b|circle\b|cir\.?\b|court\b|ct\.?\b|place\b|pl\.?\b|terrace\b|terr\.?\b|sector\b|sec\.?\b|block\b|blk\.?\b|nagar\b|colony\b|enclave\b|vihar\b|marg\b|cross\b|main\b)/gi, '[ADDRESS]');

  // 5d. Standalone street names (e.g. "Oak St.", "Oak Street", "Elm Rd", "Park Avenue")
  sanitized = sanitized.replace(/\b[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+)?\s+(?:street\b|st\.?\b|road\b|rd\.?\b|avenue\b|ave\.?\b|lane\b|ln\.?\b|drive\b|dr\.?\b|boulevard\b|blvd\.?\b|way\b|circle\b|cir\.?\b|court\b|ct\.?\b|place\b|pl\.?\b|terrace\b|terr\.?\b)/gi, '[ADDRESS]');

  // 5e. Sector and block references (e.g. "Sector 14", "Block B")
  sanitized = sanitized.replace(/\b(?:sector|sec\.?|block|blk\.?)\s*#?\s*[0-9]+[a-zA-Z]?\b/gi, '[ADDRESS]');

  // 6. Redact names in relational phrases, introductions, salutations, sign-offs, and titles
  // 6a. Relational mentions (e.g. "My friend Ravi", "Our driver Ramesh", "My colleague Priya", "His brother John")
  sanitized = sanitized.replace(/\b(?:my|our|his|her|their)?\s*(?:friend|colleague|coworker|neighbor|neighbour|driver|brother|sister|wife|husband|partner|son|daughter|boss|dad|mom|father|mother|cousin|uncle|aunt|guest|client)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/gi, (match, name) => {
    return match.replace(name, '[NAME]');
  });

  // 6b. Person descriptor mentions (e.g. "guy named Ravi", "person called Alex")
  sanitized = sanitized.replace(/\b(?:person|guy|lady|man|woman|driver|someone|somebody)\s+(?:named|called)\s+([A-Z][a-z]+)\b/gi, (match, name) => {
    return match.replace(name, '[NAME]');
  });

  // 6c. Contact / preposition mentions (e.g. "contact Ravi", "ask for Alex", "reach out to John")
  sanitized = sanitized.replace(/\b(?:contact|ask for|call for|speak with|speak to|reach out to|page)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/gi, (match, name) => {
    return match.replace(name, '[NAME]');
  });

  // 6d. Introductions (e.g. "My name is John Doe", "I am Ravi", "This is Alex")
  sanitized = sanitized.replace(/\b(?:my name is|i am|i'm|this is|from)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/gi, (match, name) => {
    return match.replace(name, '[NAME]');
  });

  // 6e. Sign-offs (e.g. "Regards, Jane Smith", "Thanks, Ravi", "Best, John")
  sanitized = sanitized.replace(/\b(?:regards|sincerely|thanks|cheers|best|warmly|yours),?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/gi, (match, name) => {
    return match.replace(name, '[NAME]');
  });

  // 6f. Titles and honorifics (e.g. "Dr. Smith", "Mr. Patel")
  sanitized = sanitized.replace(/\b(?:mr|mrs|ms|miss|dr|prof)\.?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/gi, '[NAME]');

  // 7. Redact vehicle registration plates and tags
  // 7a. Explicitly labeled plates/tags (e.g. "plate ABC123", "license plate 7XYZ89", "tag #ABC-123", "car tag 123ABC")
  sanitized = sanitized.replace(/\b(?:license\s+plate|plate|tag|\breg\b|registration|\bvin\b)\s*(?:#|no\.?|num(?:ber)?)?\s*[:\-]?\s*([A-Za-z0-9]{2,10}(?:[-\s][A-Za-z0-9]{1,6})?)\b/gi, (match, code) => {
    return match.replace(code, '[VEHICLE_REGISTRATION]');
  });

  // 7b. Indian vehicle registration plates (e.g. DL01AB1234, DL 01 AB 1234, MH-12-AB-1234, 22 BH 1234 AA)
  sanitized = sanitized.replace(/\b[A-Za-z]{2}[-\s]?[0-9]{1,2}[-\s]?[A-Za-z]{0,3}[-\s]?[0-9]{4}\b/g, '[VEHICLE_REGISTRATION]');
  sanitized = sanitized.replace(/\b[0-9]{2}[-\s]?BH[-\s]?[0-9]{4}[-\s]?[A-Za-z]{1,2}\b/gi, '[VEHICLE_REGISTRATION]');
  sanitized = sanitized.replace(/\b[A-Za-z]{2}[0-9]{2}[-\s]?[A-Za-z]{3}\b/g, '[VEHICLE_REGISTRATION]');

  // 7c. Short international plates (e.g. ABC123, ABC 123, ABC-123, ABC1234, 123-ABC, 123ABC, 7ABC123)
  sanitized = sanitized.replace(/\b[A-Za-z]{3}[-\s]?[0-9]{3,4}\b/g, '[VEHICLE_REGISTRATION]');
  sanitized = sanitized.replace(/\b[0-9]{1,4}-[A-Za-z]{2,4}\b/g, '[VEHICLE_REGISTRATION]');
  sanitized = sanitized.replace(/\b[0-9]{1,4}[A-Za-z]{2,4}\b/g, '[VEHICLE_REGISTRATION]');
  sanitized = sanitized.replace(/\b[0-9][A-Za-z]{3}[0-9]{3}\b/g, '[VEHICLE_REGISTRATION]');

  // 7d. Mixed alphanumeric tokens that look like vehicle registration or tags (e.g. 5-10 chars mixed letters & digits)
  sanitized = sanitized.replace(/\b(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{5,10}\b/g, '[VEHICLE_REGISTRATION]');

  return sanitized;
}

/**
 * Validates whether redacted text is safe to send to external AI.
 * Uses strict fail-closed verification:
 * If any identifying pattern, unredacted mixed alphanumeric token,
 * residual address/plate indicator, or unknown proper noun remains,
 * returns false to skip the external AI request and persist NORMAL priority.
 */
export function isRedactionSafe(redactedText) {
  if (typeof redactedText !== 'string' || !redactedText.trim()) return false;

  // 1. Raw email symbols or links
  if (/@/.test(redactedText)) return false;
  if (/https?:\/\//i.test(redactedText)) return false;
  if (/www\./i.test(redactedText)) return false;

  // 2. Any 4+ consecutive digits (phone, card, PIN, plate, building number)
  if (/\b\d{4,}\b/.test(redactedText)) return false;

  // 3. Any mixed alphanumeric token outside allowed placeholder tags (e.g. 12B, ABC123, 7XYZ, 4A)
  // Strips known placeholder tags first, then inspects remaining text
  const strippedTags = redactedText.replace(/\[(VEHICLE_REGISTRATION|ADDRESS|NAME|PHONE|EMAIL|IDENTIFIER|LINK)\]/g, '');
  if (/\b(?=[a-zA-Z0-9]*[a-zA-Z])(?=[a-zA-Z0-9]*\d)[a-zA-Z0-9]{2,}\b/.test(strippedTags)) {
    return false;
  }

  // 4. Residual plate / vehicle indicator words followed by unredacted letters/digits
  if (/\b(?:license\s+plate|plate|tag|\bvin\b)\s*(?:#|no\.?|num(?:ber)?)?\s*[:\-]?\s*(?!\[VEHICLE_REGISTRATION\])[a-zA-Z0-9]{2,}/i.test(redactedText)) {
    return false;
  }

  // 5. Residual street / address terms outside [ADDRESS]
  const noAddress = redactedText.replace(/\[ADDRESS\]/g, '');
  if (/\b(?:\d+[a-zA-Z]?|[A-Z][a-z]+)\s+(?:street\b|st\b|road\b|rd\b|avenue\b|ave\b|lane\b|ln\b|drive\b|dr\b|boulevard\b|blvd\b|court\b|ct\b|place\b|pl\b)|\b(?:sector|sec|block|blk)\s*#?\s*\d+/i.test(noAddress)) {
    return false;
  }

  // 6. Residual relational words followed by capitalized words
  if (/\b(?:friend|colleague|coworker|neighbor|neighbour|driver|brother|sister|wife|husband|partner|son|daughter|boss|named|called|mr|mrs|ms|dr)\s+(?!\[NAME\])[A-Z][a-z]+/.test(redactedText)) {
    return false;
  }

  // 7. Residual unknown capitalized proper nouns
  const words = strippedTags.match(/\b[A-Z][a-z]+\b/g) || [];
  for (const w of words) {
    if (!ALLOWED_CAPITALIZED_WORDS.has(w.toUpperCase())) {
      const isStartOfSentence = new RegExp('(?:^|[.!?]\\s+)' + w + '\\b').test(strippedTags.trim());
      if (!isStartOfSentence) {
        return false;
      }
    }
  }

  return true;
}

function sanitizeReason(reason, fallback = 'Default priority') {
  if (typeof reason !== 'string') return fallback;
  const trimmed = reason.trim().replace(/[\r\n\t]+/g, ' ');
  return trimmed.slice(0, 255) || fallback;
}

/**
 * Classifies the intent and urgency of a message text using Gemini API.
 * Returns { priority: 'urgent' | 'high' | 'normal' | 'low', reason: string }.
 */
export async function classifyMessagePriority(text, {
  apiKey = process.env.GEMINI_API_KEY,
  model = process.env.AI_MODEL || DEFAULT_AI_MODEL,
  timeoutMs = 4000,
} = {}) {
  // Test injection path
  if (typeof testClassifier === 'function') {
    try {
      const result = await testClassifier(text);
      if (result && typeof result === 'object') {
        const priority = PRIORITY_LEVELS.includes(String(result.priority).toLowerCase())
          ? String(result.priority).toLowerCase()
          : 'normal';
        const reason = sanitizeReason(result.reason, `Classified as ${priority}`);
        return { priority, reason };
      }
    } catch {
      return { priority: 'normal', reason: 'Default priority' };
    }
  }

  // If no AI API key is configured, fallback to NORMAL safely without claiming AI ran
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return {
      priority: 'normal',
      reason: 'Default priority',
    };
  }

  // Redact PII before external transmission
  let redactedText = '';
  try {
    redactedText = redactPiiForAi(text);
  } catch {
    return {
      priority: 'normal',
      reason: 'Default priority',
    };
  }

  // Fail closed if safe redaction could not be confirmed
  if (!isRedactionSafe(redactedText)) {
    return {
      priority: 'normal',
      reason: 'Default priority',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const prompt = `You are a vehicle parking urgency classifier for ParkX.
Analyze the following visitor message sent to a parked vehicle owner and determine its urgency and intent.

Categories:
- urgent: Blocking emergency routes/vehicles (ambulance, fire truck, police), medical emergency, imminent towing/impound, immediate safety or fire hazard.
- high: Blocking private driveway or another vehicle from leaving, car alarm blaring, vehicle lights left on, open window with rain/theft risk, physical hazard.
- normal: General parking question, timeline/duration inquiry, polite spot coordination, routine query.
- low: Compliment, greeting, casual remark, non-actionable note.

Message to analyze:
"${String(redactedText).slice(0, 1000).replace(/"/g, '\\"')}"

Allowed priorities: "urgent", "high", "normal", "low".
Respond ONLY with a valid JSON object matching this schema:
{
  "priority": "urgent",
  "reason": "concise explanation under 100 chars"
}`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 120,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return {
        priority: 'normal',
        reason: 'Default priority',
      };
    }

    // Keep timeout active through complete reading and parsing of response body
    const data = await res.json();
    const candidateText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Extract JSON from response
    const jsonMatch = candidateText.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      return {
        priority: 'normal',
        reason: 'Default priority',
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const rawPriority = String(parsed?.priority || '').toLowerCase().trim();
    const priority = PRIORITY_LEVELS.includes(rawPriority) ? rawPriority : 'normal';
    const reason = sanitizeReason(parsed?.reason, `Classified as ${priority}`);

    return { priority, reason };
  } catch {
    return {
      priority: 'normal',
      reason: 'Default priority',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asynchronously classifies a visitor message and atomically updates database records.
 * Protects against priority aggregation race conditions and never overwrites manual owner overrides.
 *
 * @returns {Promise<{ priority: string, reason: string }>}
 */
export async function classifyAndStoreMessagePriority({
  pool,
  messageId,
  sessionDbId,
  body,
  logger = console,
}) {
  if (!pool || !messageId || !body) {
    return { priority: 'normal', reason: 'Default priority' };
  }

  try {
    const { priority, reason } = await classifyMessagePriority(body);

    const connection = typeof pool.getConnection === 'function' ? await pool.getConnection() : pool;
    const canTransact = typeof connection.beginTransaction === 'function';

    try {
      if (canTransact) await connection.beginTransaction();

      // 1. Lock the session row FOR UPDATE to serialize concurrent AI priority classifications
      let sessionRow = null;
      if (sessionDbId) {
        const [sessionRows] = await connection.query(
          `SELECT id, priority_overridden, session_priority
           FROM visitor_sessions
           WHERE id = ?
           FOR UPDATE`,
          [sessionDbId]
        );
        sessionRow = sessionRows?.[0] || null;
      }

      // 2. Update message priority if not manually overridden
      await connection.query(
        `UPDATE visitor_messages
         SET priority = ?, priority_reason = ?
         WHERE id = ? AND priority_overridden = FALSE`,
        [priority, reason, messageId]
      );

      // 3. Atomically recompute aggregate session priority from highest existing message if session is NOT manually overridden
      if (sessionDbId && sessionRow && !sessionRow.priority_overridden) {
        await connection.query(
          `UPDATE visitor_sessions
           SET session_priority = COALESCE(
             (
               SELECT priority
               FROM visitor_messages
               WHERE session_id = ?
               ORDER BY FIELD(priority, 'urgent', 'high', 'normal', 'low') ASC
               LIMIT 1
             ),
             'normal'
           )
           WHERE id = ? AND priority_overridden = FALSE`,
          [sessionDbId, sessionDbId]
        );
      }

      // 4. Query the actual final persisted priorities from the database
      let finalMessagePriority = priority;
      let finalSessionPriority = priority;

      const [msgRows] = await connection.query(
        `SELECT priority, priority_overridden FROM visitor_messages WHERE id = ? LIMIT 1`,
        [messageId]
      );
      if (msgRows?.length) {
        finalMessagePriority = msgRows[0].priority;
      }

      if (sessionDbId) {
        const [sessRows] = await connection.query(
          `SELECT session_priority, priority_overridden FROM visitor_sessions WHERE id = ? LIMIT 1`,
          [sessionDbId]
        );
        if (sessRows?.length) {
          finalSessionPriority = sessRows[0].session_priority;
        } else {
          finalSessionPriority = finalMessagePriority;
        }
      }

      if (canTransact) await connection.commit();
      return {
        priority: finalSessionPriority,
        messagePriority: finalMessagePriority,
        reason,
      };
    } catch (dbErr) {
      if (canTransact && typeof connection.rollback === 'function') {
        try { await connection.rollback(); } catch {}
      }
      throw dbErr;
    } finally {
      if (typeof connection.release === 'function') {
        connection.release();
      }
    }
  } catch (err) {
    if (logger?.error) {
      logger.error('Failed to classify message priority', {
        messageId,
        code: err?.code,
      });
    }
    return { priority: 'normal', reason: 'Default priority' };
  }
}
