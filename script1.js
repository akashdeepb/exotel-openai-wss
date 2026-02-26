const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// --- Fixed Constants ---
const EXOTEL_SAMPLE_RATE = 8000;
const OPENAI_SAMPLE_RATE = 24000;

// Bytes per ms of audio at 8kHz PCM16 (8000 samples/s * 2 bytes/sample / 1000)
const EXOTEL_BYTES_PER_MS = (EXOTEL_SAMPLE_RATE * 2) / 1000; // = 16

// Extra time (ms) to wait after audio finishes playing before opening the mic.
// Accounts for phone speaker echo tail on Indian mobile networks.
const ECHO_TAIL_MS = 500;

// Min bytes before flushing a batch to Exotel (~20ms of audio). Balances latency vs jitter.
const MIN_OUT_BYTES = 320;

// --- Mutable Runtime Config (editable via /api/config) ---
const config = {
    model: 'gpt-4o-realtime-preview',
    voice: 'shimmer',
    silenceTimeoutMs: 900,  // how long of silence before AI responds; children need more time
    vadThreshold: 0.3,      // lower = more sensitive; 0.3 works well for children's voices
    systemInstructions: `You are Monika, a warm learning assistant calling from Saajha NGO in India. You speak Hinglish — Hindi and English mixed naturally, like Indian people normally talk.

THE MOST IMPORTANT RULE: After saying anything, STOP and wait silently for the other person to reply. Do not say another word until they have responded. Say one short thing, then wait.

YOUR SCRIPT — follow in order, one step at a time. Wait for a reply before moving to the next step.

1. Greet the parent warmly. "Namaste! Kaise hain aap?"
2. Tell them who you are. "Main Monika hoon, Saajha NGO se call kar rahi hoon."
3. Ask if the child is available. "Kya bachha available hai? Thodi si practice karni thi unse."
4. Once the child is on: Greet them! Ask their name.
5. Ask their study plan. "Aaj ka study plan kya hai tumhara? Batao mujhe!"
6. Appreciate their plan. Then say: "Chalo, ab thoda maths karte hain!"
7. Ask these math questions ONE AT A TIME. Ask one, then wait for the answer before saying anything.

   Question 1: "Batao zara — 5 aur 2 kitne hote hain?" (answer: 7)
   Question 2: "Bahut achha! Ab batao — 7 aur 5 kitne hote hain?" (answer: 12)
   Question 3: "7 mein se 5 ghatao toh kya bachega?" (answer: 2)
   Question 4: "12 mein se 5 ghatao?" (answer: 7)
   Question 5: "5 ko 2 se multiply karo toh kya aata hai?" (answer: 10)

   - If correct: "Shabash! Bilkul sahi!" then ask next question.
   - If wrong: gently explain with counting, try again. Maximum 3 tries.
   - If no answer: "Koi baat nahi, time lo!"

8. After all questions: praise them warmly, remind them to follow their study plan, warm goodbye.

STYLE: One sentence at a time. Warm and encouraging. Never rush. Always wait.`
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
                if (u.model !== undefined)              config.model              = u.model;
                if (u.voice !== undefined)              config.voice              = u.voice;
                if (u.systemInstructions !== undefined) config.systemInstructions = u.systemInstructions;
                console.log('⚙️  Config updated:', {
                    model: config.model, voice: config.voice,
                    silenceTimeoutMs: config.silenceTimeoutMs, vadThreshold: config.vadThreshold
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

    const callConfig = { ...config }; // snapshot — changes mid-call won't affect this call

    // ---- State machine ----
    // idle       → call connected, waiting for both sides to be ready
    // responding → AI is generating + streaming audio; mic is closed
    // settling   → AI audio done; waiting for Exotel to finish playing + echo to settle
    // listening  → mic open, user audio forwarded to OpenAI
    let state = 'idle';
    let settleTimer = null;

    // Ready flags — greeting fires only when both are true
    let streamSid     = null;
    let sessionReady  = false;
    let greetingSent  = false;

    // Output audio batch buffer
    let outBuffer         = [];
    let outBufferSize     = 0;
    let responseBytesOut  = 0; // total bytes sent to Exotel this response (for dynamic gate calc)

    // ---- State helpers ----

    function setState(s) {
        console.log(`  [${streamSid || 'pre-start'}] ${state} → ${s}`);
        state = s;
    }

    function sendAudioToExotel(buf) {
        if (exotelWs.readyState !== WebSocket.OPEN) return;
        exotelWs.send(JSON.stringify({
            event: 'media',
            media: { payload: buf.toString('base64'), format: 'pcm16', sample_rate: EXOTEL_SAMPLE_RATE }
        }));
    }

    function flushOutBuffer(force = false) {
        if (outBufferSize === 0) return;
        if (!force && outBufferSize < MIN_OUT_BYTES) return;
        const buf = Buffer.concat(outBuffer);
        outBuffer     = [];
        outBufferSize = 0;
        responseBytesOut += buf.length;
        sendAudioToExotel(buf);
    }

    function discardOutBuffer() {
        outBuffer        = [];
        outBufferSize    = 0;
        responseBytesOut = 0;
    }

    // After an AI response, calculate how long Exotel will be playing the audio,
    // then wait that long + ECHO_TAIL_MS before re-opening the mic.
    //
    // Why dynamic? OpenAI generates audio ~3–5x faster than real-time.
    // A 10s greeting arrives at our server in ~2s and is flushed to Exotel in ~2s.
    // But Exotel plays it for the full 10s. A fixed 800ms gate would open while
    // the AI is still talking → echo → VAD fires → new response → chaos.
    function scheduleListening() {
        if (settleTimer) clearTimeout(settleTimer);

        const playbackMs = responseBytesOut / EXOTEL_BYTES_PER_MS;
        const gateMs     = Math.max(800, playbackMs + ECHO_TAIL_MS);

        console.log(`  Settle gate: ${Math.round(playbackMs)}ms playback + ${ECHO_TAIL_MS}ms tail = ${Math.round(gateMs)}ms`);

        responseBytesOut = 0;
        setState('settling');

        settleTimer = setTimeout(() => {
            settleTimer = null;
            // Clear any residual echo that leaked into the OpenAI buffer
            if (openAIWs.readyState === WebSocket.OPEN) {
                openAIWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
            }
            setState('listening');
        }, gateMs);
    }

    // Trigger greeting only once both the Exotel stream and OpenAI session are ready.
    // This prevents response.create firing before session.update is acknowledged
    // (which would use wrong voice/VAD config).
    function triggerGreeting() {
        if (greetingSent || !streamSid || !sessionReady) return;
        if (openAIWs.readyState !== WebSocket.OPEN) return;

        greetingSent = true;
        console.log('  👋 Triggering greeting');

        // Clear any background noise accumulated in the buffer before we send the greeting.
        // Without this, the VAD might detect that noise as speech and fire speech_started,
        // which cancels the greeting mid-sentence.
        openAIWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));

        setState('responding');
        openAIWs.send(JSON.stringify({
            type: 'response.create',
            response: { modalities: ['audio', 'text'] }
        }));
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
        console.log(`✅ OpenAI connected (${callConfig.model} / ${callConfig.voice})`);

        openAIWs.send(JSON.stringify({
            type: 'session.update',
            session: {
                instructions: callConfig.systemInstructions,
                voice: callConfig.voice,
                input_audio_format: 'pcm16',
                output_audio_format: 'pcm16',
                modalities: ['audio', 'text'],
                temperature: 0.8,
                // No max_response_output_tokens — let the AI finish its sentences naturally.
                // Response length is controlled by the system prompt instructions.
                turn_detection: {
                    type: 'server_vad',
                    threshold: callConfig.vadThreshold,
                    prefix_padding_ms: 300,
                    silence_duration_ms: callConfig.silenceTimeoutMs,
                    create_response: true
                }
            }
        }));
    });

    openAIWs.on('error', (err) => console.error('*** OPENAI WS ERROR:', err.message));

    openAIWs.on('close', () => {
        console.log('❌ OpenAI disconnected');
        if (exotelWs.readyState === WebSocket.OPEN) exotelWs.close();
    });

    // ---- Exotel → OpenAI ----
    exotelWs.on('message', (message) => {
        const data = JSON.parse(message.toString());

        if (data.event === 'media') {
            // Only forward audio when mic is open.
            // In all other states (responding, settling), audio is dropped to prevent
            // the AI's speaker output from being picked up by the mic (echo loop).
            if (state !== 'listening') return;

            const chunk    = Buffer.from(data.media.payload, 'base64');
            const resampled = resampleAudioChunk(chunk, EXOTEL_SAMPLE_RATE, OPENAI_SAMPLE_RATE);

            if (openAIWs.readyState === WebSocket.OPEN) {
                openAIWs.send(JSON.stringify({
                    type: 'input_audio_buffer.append',
                    audio: resampled.toString('base64')
                }));
            }

        } else if (data.event === 'start') {
            streamSid = data.start.stream_sid;
            console.log('📡 Stream started:', streamSid);
            triggerGreeting();

        } else if (data.event === 'stop') {
            console.log('📵 Stream stopped');
        }
    });

    // ---- OpenAI → Exotel ----
    openAIWs.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(Buffer.isBuffer(message) ? message.toString() : message);
        } catch (e) {
            console.error('*** OPENAI PARSE ERROR:', e);
            return;
        }

        // Session fully configured — safe to trigger greeting
        if (data.type === 'session.updated') {
            sessionReady = true;
            triggerGreeting();
        }

        // AI starting to respond (either our greeting trigger or server VAD auto-response)
        if (data.type === 'response.created') {
            if (state !== 'responding') setState('responding');
        }

        // Stream AI audio chunks to Exotel, batched for smooth delivery
        if (data.type === 'response.audio.delta' && data.delta) {
            const chunk    = Buffer.from(data.delta, 'base64');
            const resampled = resampleAudioChunk(chunk, OPENAI_SAMPLE_RATE, EXOTEL_SAMPLE_RATE);
            outBuffer.push(resampled);
            outBufferSize += resampled.length;
            flushOutBuffer();
        }

        // All AI audio received — flush remainder, then wait for playback + echo to settle
        if (data.type === 'response.audio.done') {
            flushOutBuffer(true);
            scheduleListening();
        }

        // Full response done (text + audio both complete)
        if (data.type === 'response.done') {
            if (state === 'responding') {
                // response.audio.done didn't fire (e.g. text-only response edge case)
                scheduleListening();
            }
        }

        // Response was cancelled mid-stream
        if (data.type === 'response.cancelled') {
            flushOutBuffer(true);
            discardOutBuffer();
            scheduleListening();
        }

        if (data.type === 'error') {
            console.error('*** OPENAI ERROR:', data.error?.message);
            discardOutBuffer();
            if (state !== 'listening') scheduleListening();
        }
    });

    exotelWs.on('close', () => {
        console.log('❌ Exotel disconnected, cleaning up');
        if (settleTimer) clearTimeout(settleTimer);
        if (openAIWs.readyState === WebSocket.OPEN) openAIWs.close();
    });
});

server.listen(8080, () => {
    console.log('🚀 Server running on port 8080');
    console.log('   WebSocket: ws://YOUR_SERVER_IP:8080');
    console.log('   Config UI: http://YOUR_SERVER_IP:8080');
});
