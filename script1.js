const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// --- Fixed Constants ---
const EXOTEL_SAMPLE_RATE = 8000;
const OPENAI_SAMPLE_RATE = 24000;

// ~40ms of audio at 8kHz before flushing to Exotel — smooth delivery without felt latency
const MIN_OUT_BYTES = 640;

// How long to keep input muted after AI finishes speaking, to let phone echo die out.
// Phone speaker → mic echo typically settles within 600–800ms on Indian mobile networks.
const ECHO_GATE_MS = 800;

// --- Mutable Runtime Config (editable via /api/config) ---
const config = {
    model: 'gpt-4o-realtime-preview',
    voice: 'shimmer',          // warm, clear voice — works well for children
    silenceTimeoutMs: 900,     // ms of silence before AI responds — children need more time to think
    vadThreshold: 0.3,         // lower = catches quieter children's voices (0.0–1.0)
    maxResponseTokens: 80,     // hard cap: forces 1–2 sentence responses, prevents rambling
    systemInstructions: `You are Monika, a warm and patient teaching assistant calling from Saajha NGO in India. You speak natural Hinglish (Hindi + English mixed, like everyday Indian conversation).

YOUR MOST IMPORTANT RULE: Say ONE short thing (1–2 sentences maximum), then STOP and wait silently for a response. Never say two things in a row without hearing a reply first. Never move to the next topic without getting an answer.

CALL FLOW — cover each step in order, waiting for a reply before moving on:

Step 1: Greet the parent warmly. Ask how they are. Then stop and wait.
Step 2: Tell them you are calling from Saajha for some fun practice with the child. Ask if the child can come to the phone. Then stop and wait.
Step 3: Greet the child cheerfully. Ask their name. Then stop and wait.
Step 4: Ask the child to tell you their study plan for today in one or two sentences. Then stop and wait.
Step 5: Praise their plan warmly. Say "Chalo, ab thoda maths karte hain!" Then stop and wait.
Step 6: Ask the math questions below, one at a time. After each question, stop completely and wait for the child's answer before saying anything else.

MATH QUESTIONS (ask exactly one, then wait):
Q1: "Batao — 5 aur 2 kitne hote hain?" (correct answer: 7)
Q2: "Ab batao — 7 aur 5 kitne hote hain?" (correct answer: 12)
Q3: "7 mein se 5 ghatao toh kya bachega?" (correct answer: 2)
Q4: "12 mein se 5 ghatao?" (correct answer: 7)
Q5: "5 ka 2 se multiply karo toh kya aata hai?" (correct answer: 10)

For each answer:
- Correct: say "Shabash! Bilkul sahi!" and move to the next question.
- Wrong: gently say the correct answer with a simple example, then ask them to try again (maximum 3 attempts per question).
- No answer or long silence: say "Koi baat nahi, time lo. Sochte sochte batao!"

Step 7: After all five questions, praise the child warmly. Remind them to stick to their study plan. Say a warm goodbye.

ALWAYS:
- 1–2 sentences per response. Stop after that.
- Be warm, patient, and encouraging.
- Never rush or list multiple things at once.
- Wait. The child needs time to think.`
};

// --- Audio Resampling (Linear Interpolation) ---
function resampleAudioChunk(inputBuffer, inputSampleRate, outputSampleRate) {
    if (inputSampleRate === outputSampleRate) return inputBuffer;

    const ratio = outputSampleRate / inputSampleRate;
    const inputSamples = inputBuffer.length / 2;
    const outputSamples = Math.floor(inputSamples * ratio);
    const outputBuffer = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
        const inputIndexFloat = i / ratio;
        const inputIndex1 = Math.floor(inputIndexFloat);
        const inputIndex2 = Math.min(inputSamples - 1, inputIndex1 + 1);
        const fraction = inputIndexFloat - inputIndex1;
        const sample1 = inputBuffer.readInt16LE(inputIndex1 * 2);
        const sample2 = inputBuffer.readInt16LE(inputIndex2 * 2);
        outputBuffer.writeInt16LE(Math.round(sample1 + (sample2 - sample1) * fraction), i * 2);
    }

    return outputBuffer;
}

// ----------------- HTTP Server (Config UI + API) -----------------
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) { res.writeHead(404); res.end('Not found'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    if (req.method === 'GET' && req.url === '/api/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config));
        return;
    }

    if (req.method === 'POST' && req.url === '/api/config') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const u = JSON.parse(body);
                if (u.silenceTimeoutMs !== undefined)  config.silenceTimeoutMs  = Number(u.silenceTimeoutMs);
                if (u.vadThreshold !== undefined)       config.vadThreshold       = Number(u.vadThreshold);
                if (u.maxResponseTokens !== undefined)  config.maxResponseTokens  = Number(u.maxResponseTokens);
                if (u.model !== undefined)              config.model              = u.model;
                if (u.voice !== undefined)              config.voice              = u.voice;
                if (u.systemInstructions !== undefined) config.systemInstructions = u.systemInstructions;
                console.log('⚙️  Config updated:', {
                    model: config.model, voice: config.voice,
                    silenceTimeoutMs: config.silenceTimeoutMs,
                    vadThreshold: config.vadThreshold,
                    maxResponseTokens: config.maxResponseTokens
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(config));
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

// ----------------- WebSocket Server -----------------
const wss = new WebSocket.Server({ server });

wss.on('connection', (exotelWs) => {
    console.log('📞 Exotel connected');

    // Snapshot config at connection time so mid-call UI changes don't disrupt this call
    const callConfig = { ...config };

    let activeResponse = false;
    let queuedChunks   = [];

    // Input gate: while true, Exotel audio is NOT forwarded to OpenAI.
    // Purpose: prevent the AI's own audio (played through the phone speaker) from
    // being picked up by the mic, sent back, and triggering a new response (echo loop).
    let inputGated    = true;  // start gated — opens only after session is configured
    let echoGateTimer = null;

    // Track whether both sides are ready before triggering the greeting
    let streamSid          = null;
    let sessionConfigured  = false;
    let initialGreetingSent = false;

    // Output audio batch buffer
    let outBuffer     = [];
    let outBufferSize = 0;

    // ---- Helpers ----

    function flushOutBuffer(force = false) {
        if (outBufferSize === 0) return;
        if (!force && outBufferSize < MIN_OUT_BYTES) return;
        const combined = Buffer.concat(outBuffer);
        outBuffer     = [];
        outBufferSize = 0;
        if (exotelWs.readyState === WebSocket.OPEN) {
            exotelWs.send(JSON.stringify({
                event: 'media',
                media: { payload: combined.toString('base64'), format: 'pcm16', sample_rate: EXOTEL_SAMPLE_RATE }
            }));
        }
    }

    function discardOutBuffer() {
        outBuffer     = [];
        outBufferSize = 0;
    }

    // Close the input gate immediately (blocks Exotel audio from reaching OpenAI)
    function closeInputGate() {
        if (echoGateTimer) { clearTimeout(echoGateTimer); echoGateTimer = null; }
        inputGated = true;
    }

    // Schedule the input gate to open after ECHO_GATE_MS (lets phone echo die out)
    function scheduleOpenInputGate() {
        if (echoGateTimer) clearTimeout(echoGateTimer);
        echoGateTimer = setTimeout(() => {
            inputGated    = false;
            echoGateTimer = null;
            console.log('🎤 Listening for user');
        }, ECHO_GATE_MS);
    }

    // Cancel the current AI response and clean up state.
    // Sends input_audio_buffer.clear so the dirty echo-contaminated buffer
    // doesn't get transcribed and confuse the next turn.
    function cancelActiveResponse() {
        if (activeResponse && openAIWs.readyState === WebSocket.OPEN) {
            openAIWs.send(JSON.stringify({ type: 'response.cancel' }));
            openAIWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
        }
        activeResponse = false;
        discardOutBuffer();
    }

    // Trigger the initial greeting once both the Exotel stream AND the OpenAI
    // session.updated acknowledgement have arrived — avoids the race where
    // response.create fires before the session is fully configured.
    function tryTriggerGreeting() {
        if (!streamSid || !sessionConfigured || initialGreetingSent) return;
        if (openAIWs.readyState !== WebSocket.OPEN) return;

        console.log('👋 Triggering greeting');
        closeInputGate();
        openAIWs.send(JSON.stringify({
            type: 'response.create',
            response: {
                modalities: ['audio', 'text'],
                max_response_output_tokens: callConfig.maxResponseTokens
            }
        }));
        initialGreetingSent = true;
        activeResponse = true;
    }

    // ---- OpenAI Realtime connection ----
    const openAIWs = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=${callConfig.model}`,
        {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        }
    );

    openAIWs.on('open', () => {
        console.log(`✅ OpenAI connected (model: ${callConfig.model}, voice: ${callConfig.voice})`);

        openAIWs.send(JSON.stringify({
            type: 'session.update',
            session: {
                instructions: callConfig.systemInstructions,
                voice: callConfig.voice,
                input_audio_format: 'pcm16',
                output_audio_format: 'pcm16',
                modalities: ['audio', 'text'],
                temperature: 0.7,
                max_response_output_tokens: callConfig.maxResponseTokens,
                turn_detection: {
                    type: 'server_vad',
                    threshold: callConfig.vadThreshold,
                    prefix_padding_ms: 300,
                    silence_duration_ms: callConfig.silenceTimeoutMs,
                    create_response: true
                }
            }
        }));

        // Flush any audio chunks that arrived before the connection was ready
        if (queuedChunks.length > 0) {
            queuedChunks.forEach(chunk => {
                openAIWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') }));
            });
            queuedChunks = [];
        }
    });

    openAIWs.on('error', (err) => console.error('*** OPENAI WS ERROR:', err.message));

    openAIWs.on('close', () => {
        console.log('❌ OpenAI disconnected');
        if (exotelWs.readyState === WebSocket.OPEN) exotelWs.close();
    });

    // ---- Exotel → OpenAI (incoming call audio) ----
    exotelWs.on('message', (message) => {
        const data = JSON.parse(message.toString());

        if (data.event === 'media') {
            // Gate: drop audio while AI is speaking to break the echo feedback loop.
            // Without this, the AI's voice played through the phone speaker gets picked
            // up by the mic, sent back as user audio, and triggers another response —
            // making the AI talk to itself in an infinite loop.
            if (inputGated) return;

            const audioChunk = Buffer.from(data.media.payload, 'base64');
            const resampled  = resampleAudioChunk(audioChunk, EXOTEL_SAMPLE_RATE, OPENAI_SAMPLE_RATE);

            if (openAIWs.readyState === WebSocket.OPEN) {
                openAIWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: resampled.toString('base64') }));
            } else {
                queuedChunks.push(resampled);
            }

        } else if (data.event === 'start') {
            streamSid = data.start.stream_sid;
            console.log('📡 Stream started:', streamSid);
            tryTriggerGreeting();

        } else if (data.event === 'stop') {
            console.log('📵 Stream stopped');
        }
    });

    // ---- OpenAI → Exotel (AI responses) ----
    openAIWs.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(Buffer.isBuffer(message) ? message.toString() : message);
        } catch (e) {
            console.error('*** OPENAI PARSE ERROR:', e);
            return;
        }

        // Session is fully configured — safe to trigger the greeting now
        if (data.type === 'session.updated') {
            sessionConfigured = true;
            tryTriggerGreeting();
        }

        // AI response started — gate input to prevent echo from triggering another response
        if (data.type === 'response.created') {
            activeResponse = true;
            closeInputGate();
        }

        // User started speaking while AI is responding (barge-in).
        // With input gating this should rarely fire mid-response — mainly a safety net
        // for the window between gate opening and the next response starting.
        if (data.type === 'input_audio_buffer.speech_started') {
            console.log('🎙️  User speaking');
            if (activeResponse) {
                cancelActiveResponse();
            }
        }

        // Stream AI audio to Exotel — batched for smooth delivery
        if (data.type === 'response.audio.delta' && data.delta) {
            const chunk    = Buffer.from(data.delta, 'base64');
            const resampled = resampleAudioChunk(chunk, OPENAI_SAMPLE_RATE, EXOTEL_SAMPLE_RATE);
            outBuffer.push(resampled);
            outBufferSize += resampled.length;
            flushOutBuffer(); // sends only when MIN_OUT_BYTES accumulated
        }

        // AI finished speaking — flush remaining audio, then open input gate after echo settles
        if (data.type === 'response.audio.done') {
            flushOutBuffer(true);
            activeResponse = false;
            scheduleOpenInputGate();
        }

        if (data.type === 'response.done') {
            activeResponse = false;
        }

        // Response was cancelled (e.g., due to barge-in) — open gate after brief cooldown
        if (data.type === 'response.cancelled') {
            flushOutBuffer(true);
            activeResponse = false;
            discardOutBuffer();
            scheduleOpenInputGate();
        }

        if (data.type === 'error') {
            console.error('*** OPENAI ERROR:', data.error?.message);
            activeResponse = false;
            discardOutBuffer();
            scheduleOpenInputGate();
        }
    });

    exotelWs.on('close', () => {
        console.log('❌ Exotel disconnected, cleaning up');
        if (echoGateTimer) clearTimeout(echoGateTimer);
        if (openAIWs.readyState === WebSocket.OPEN) openAIWs.close();
    });
});

server.listen(8080, () => {
    console.log('🚀 Server running on port 8080');
    console.log('   WebSocket: ws://YOUR_SERVER_IP:8080');
    console.log('   Config UI: http://YOUR_SERVER_IP:8080');
});
