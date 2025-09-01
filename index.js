import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import OpenAI from 'openai'

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

const port = process.env.PORT || 3000

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
const hasOpenAIKey = !!process.env.OPENAI_API_KEY
const useMockByEnv = process.env.USE_MOCK === '1' || process.env.USE_MOCK === 'true'

// OpenAI v4 client (only created if we have a key)
const openai = hasOpenAIKey ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null

// simple, deterministic mock generator that returns JSON (as string)
function buildMockAdvice({ userProfile = {}, protocol = 'Keto', doctorNotes = '' }) {
  const weight = Number(userProfile.weight ?? 255.3)
  const goalWeight = Number(userProfile.goalWeight ?? 190)
  const delta = Math.max(0, weight - goalWeight)

  // protein target heuristic (e.g., 0.8–1.0 g/lb goal-lean range; cap sane bounds)
  const proteinG = Math.min(230, Math.max(120, Math.round(0.8 * (goalWeight || 190))))

  // hydration target heuristic (3–4 L baseline; +0.5 L if active or delta large)
  const hydrationL = Math.min(5, Math.max(3, 3 + (delta > 30 ? 0.5 : 0)))

  // keep given protocol or nudge if user wrote "Fat Fast"/"PSMF"
  const normalizedPhase = (protocol || 'Keto').toString()

  const rules = [
    `Hit ≥ ${proteinG} g protein today (shakes + meal 3).`,
    `Hydration: ${hydrationL} L by bedtime (500–750 mL every 2–3h).`,
    `Stop last meal 5–6h before sleep.`,
    `Log symptoms (migraine, nausea, IBS) and meds.`,
    `Movement: 40 min baseline (80% low intensity, 20% HIIT) if energy ok.`
  ]

  if (/fat\s*fast/i.test(normalizedPhase)) {
    rules.unshift('Fat Fast: 1000–1200 kcal, 85–90% fat, 3 days max.')
  }
  if (/psmf/i.test(normalizedPhase)) {
    rules.unshift('PSMF: 180–190 g protein, very low fat/carbs, electrolytes daily.')
  }

  if (doctorNotes) {
    rules.push(`Note from doctor plan considered: ${String(doctorNotes).slice(0, 120)}...`)
  }

  const notes =
    'Mock mode active. This advice is generated locally for development. When API billing is ready, disable mock to use NeuroFuel GPT.'

  return JSON.stringify({
    hydrationL,
    proteinG,
    phase: normalizedPhase,
    rules,
    notes
  })
}

// healthcheck
app.get('/health', (req, res) => {
  const key = process.env.OPENAI_API_KEY || ''
  const mockQuery = req.query.mock === '1' || req.query.mock === 'true'
  res.json({
    ok: true,
    hasKey: Boolean(key),
    keyPrefix: key ? key.slice(0, 7) + '...' : null,
    gptId: process.env.GPT_ID || null,
    usingMock: useMockByEnv || mockQuery || !hasOpenAIKey,
    port
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Main endpoint with auto-mock fallback
// ──────────────────────────────────────────────────────────────────────────────
app.post('/gpt/advice', async (req, res) => {
  const { userProfile, protocol, doctorNotes } = req.body || {}

  const mockRequested = req.query.mock === '1' || req.query.mock === 'true'
  const shouldMock = useMockByEnv || mockRequested || !hasOpenAIKey

  // If mock requested/forced, return mock immediately
  if (shouldMock) {
    const mockJson = buildMockAdvice({ userProfile, protocol, doctorNotes })
    return res.json({ result: mockJson })
  }

  // Otherwise try real OpenAI; if it fails (429/401/etc.), fall back to mock
  const prompt = `
You are NeuroFuel GPT — a post-TBI recovery and metabolic health assistant.
Return *pure JSON* with this exact schema (no extra text):
{
  "hydrationL": number,
  "proteinG": number,
  "phase": string,
  "rules": string[],
  "notes": string
}

User Profile: ${JSON.stringify(userProfile ?? {}, null, 2)}
Protocol: ${protocol ?? ""}
Doctor Notes: ${doctorNotes ?? ""}
`.trim()

  try {
    const extra = process.env.GPT_ID ? { extra_body: { gpt_id: process.env.GPT_ID } } : {}
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      ...extra
    })
    const content = completion.choices?.[0]?.message?.content ?? ''
    return res.json({ result: content })
  } catch (err) {
    console.error('— OpenAI ERROR —')
    console.error('type   :', err?.name)
    console.error('status :', err?.status || err?.response?.status)
    console.error('message:', err?.message)
    try { console.error('data   :', err?.response?.data) } catch {}

    // graceful fallback to mock so your app keeps working
    const mockJson = buildMockAdvice({ userProfile, protocol, doctorNotes })
    return res.json({
      result: mockJson,
      _warning: 'OpenAI request failed; served mock instead'
    })
  }
})

// Use your specific GPT ID
const YOUR_GPT_ID = "g-68748c6128d08191b721d600c5f99b90-neurofuel";

app.post('/gpt/chat', async (req, res) => {
    try {
        // Handle both 'message' and 'prompt' fields for compatibility
        const message = req.body.message || req.body.prompt;
        
        // Add debug logging
        console.log('Received request:', {
            body: req.body,
            message: message,
            messageType: typeof message,
            messageLength: message?.length
        });
        
        // Check if we have a valid message
        if (!message || typeof message !== 'string') {
            return res.status(400).json({ 
                error: 'Invalid message',
                message: 'Request must contain either "message" or "prompt" field with a string value',
                received: req.body
            });
        }
        
        // Check if OpenAI is available
        if (!openai) {
            console.log('OpenAI not available - returning error');
            return res.status(500).json({ 
                error: 'OpenAI API not configured',
                message: 'Please set OPENAI_API_KEY environment variable'
            });
        }

        console.log('OpenAI client available, making API call...');
        console.log('Message to send:', message);

        // Create a prompt that mimics your custom GPT's behavior
        const systemPrompt = `You are NeuroFuel GPT, a specialized health and wellness assistant for NeuroFuel app users. 
        
Your role is to help with:
- Nutrition and meal planning
- Exercise recommendations
- Mental health support
- Recovery tracking
- Post-TBI (Traumatic Brain Injury) recovery guidance
- Metabolic health optimization

Provide helpful, supportive, and evidence-based advice. Be encouraging and practical in your responses.`;

        console.log('System prompt:', systemPrompt);

        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: message }
            ],
            temperature: 0.7,
            max_tokens: 500
        });

        console.log('OpenAI response received:', {
            status: 'success',
            model: completion.model,
            usage: completion.usage,
            responseLength: completion.choices?.[0]?.message?.content?.length
        });

        const response = completion.choices?.[0]?.message?.content ?? 'Sorry, I could not generate a response.';
        
        console.log('Final response being sent:', response.substring(0, 100) + '...');
        
        res.json({ text: response });
        
    } catch (error) {
        console.error('Error in /gpt/chat:', error);
        console.error('Error details:', {
            name: error.name,
            message: error.message,
            status: error.status,
            code: error.code
        });
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Meal plan parameters extraction endpoint
app.post('/gpt/meal-plan-params', async (req, res) => {
    try {
        // Handle both 'message' and 'prompt' fields for compatibility
        const message = req.body.message || req.body.prompt;
        
        // Check if we have a valid message
        if (!message || typeof message !== 'string') {
            return res.status(400).json({ 
                error: 'Invalid message',
                message: 'Request must contain either "message" or "prompt" field with a string value',
                received: req.body
            });
        }
        
        // Check if OpenAI is available
        if (!openai) {
            return res.status(500).json({ 
                error: 'OpenAI API not configured',
                message: 'Please set OPENAI_API_KEY environment variable'
            });
        }

        const systemPrompt = `Extract meal planning parameters from the user's message. Return ONLY a JSON object with these fields:
{
  "servings": number (how many people to feed),
  "dailyCalories": number (target calories per day),
  "dietType": string (diet preference like "Keto", "Balanced", "PSMF", etc.),
  "durationDays": number (how many days to plan for)
}

If a field cannot be determined, use null.`;

        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: message }
            ],
            temperature: 0.1,
            max_tokens: 200
        });

        const response = completion.choices?.[0]?.message?.content ?? '{}';
        
        try {
            const params = JSON.parse(response);
            res.json(params);
        } catch (parseError) {
            res.json({ servings: null, dailyCalories: null, dietType: null, durationDays: null });
        }
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.listen(port, () => {
  console.log(`✅ AI advisor backend running on :${port}`)
  console.log('Environment check:', {
    hasKey: !!process.env.OPENAI_API_KEY,
    keyLength: process.env.OPENAI_API_KEY?.length || 0,
    keyPrefix: process.env.OPENAI_API_KEY?.slice(0, 10) || 'none',
    keyEnd: process.env.OPENAI_API_KEY?.slice(-10) || 'none',
    keyContainsSpaces: process.env.OPENAI_API_KEY?.includes(' ') || false,
    keyContainsQuotes: process.env.OPENAI_API_KEY?.includes('"') || process.env.OPENAI_API_KEY?.includes("'") || false
  });
})
