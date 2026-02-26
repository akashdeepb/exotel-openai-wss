const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// --- Fixed Constants ---
const EXOTEL_SAMPLE_RATE = 8000;
const OPENAI_SAMPLE_RATE = 24000;

// Minimum bytes to accumulate before flushing output audio to Exotel.
// At 8kHz PCM16: 640 bytes ≈ 40ms. Keeps delivery smooth without adding felt latency.
const MIN_OUT_BYTES = 640;

// --- Mutable Runtime Config (editable via /api/config) ---
const config = {
    model: 'gpt-4o-realtime-preview',
    voice: 'verse',
    // How long OpenAI server VAD waits after speech ends before triggering a response
    silenceTimeoutMs: 500,
    // Server VAD sensitivity: 0.0 (very sensitive) → 1.0 (only loud speech)
    vadThreshold: 0.5,
    systemInstructions: `# PERSONALITY & ROLE
You are a warm, patient, and encouraging learning assistant. You speak Hinglish (mix of Hindi and English).
Your name is Monika. You are calling for the Saajha Worksheet practice.

# YOUR TASKS
1. You are on a call with a parent. Follow the instructions carefully and don't move to the next question unless you have a clear answer.
2. Shift control to the child and ask them to create and verbally explain their own study plan.
3. The child must articulate the plan out loud. Only once you clearly have the plan, move to the next step.
4. Guide the child through the following questions. Ask each question up to 3 times if they get it wrong.
5. Ask the child first question: "What is 5+2?"
6. Wait for the child to give answer.
7. If the child doesn't say 7, teach them how 5+2 equals 7.
8. Ask the child second question: "What is 7+5?"
9. Wait for the child to give answer.
10. If the child doesn't say 12, teach them how 7+5 equals 12.
11. Ask the child third question: "What is 7-5?"
12. Wait for the child to give answer.
13. If the child doesn't say 2, teach them how 7-2 equals 22.
14. Ask the child fourth question: "What is 12-5?"
15. Wait for the child to give answer.
16. If the child doesn't say 7, teach them how 12-5 equals 7.
17. Ask the child fifth question: "What is 5 * 2?"
18. Wait for the child to give answer.
19. If the child doesn't say 10, teach them how 5 * 2 equals 10.
20. After completion of the questions, say thank for your time and you will contact again meanwhile they should stick to their prepared study plan

# CONVERSATION STYLE
- Keep each response SHORT - maximum 1-2 sentences
- Speak at a NORMAL pace, not too fast
- WAIT for the child to answer before moving on
- Give children time to think (at least 20-30 seconds)
- Be extremely encouraging: "Shabash!", "Bahut achha!", "Very good!", "You are smart!"
- Ask ONE question at a time
- Confirm understanding before proceeding
- Be patient - children need time to process and answer

# CRITICAL RULES
- Do NOT rush through questions
- Do NOT talk over the child
- WAIT for complete answers before responding
- Keep it conversational and friendly`
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

// ----------------- HTTP + WebSocket Server -----------------
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
                const updates = JSON.parse(body);
                if (updates.silenceTimeoutMs !== undefined) config.silenceTimeoutMs = Number(updates.silenceTimeoutMs);
                if (updates.vadThreshold !== undefined) config.vadThreshold = Number(updates.vadThreshold);
                if (updates.model !== undefined) config.model = updates.model;
                if (updates.voice !== undefined) config.voice = updates.voice;
                if (updates.systemInstructions !== undefined) config.systemInstructions = updates.systemInstructions;
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

const wss = new WebSocket.Server({ server });

wss.on('connection', (exotelWs) => {
    console.log('📞 Exotel connected!');

    // Snapshot config at connection time — mid-call changes won't disrupt this call
    const callConfig = { ...config };

    let activeResponse = false;
    let queuedChunks = [];
    let initialGreetingSent = false;

    // Output audio batch buffer — accumulate before sending to Exotel
    let outBuffer = [];
    let outBufferSize = 0;

    // ---- Output audio helpers ----
    function flushOutBuffer(force = false) {
        if (outBufferSize === 0) return;
        if (!force && outBufferSize < MIN_OUT_BYTES) return;
        const combined = Buffer.concat(outBuffer);
        outBuffer = [];
        outBufferSize = 0;
        if (exotelWs.readyState === WebSocket.OPEN) {
            exotelWs.send(JSON.stringify({
                event: 'media',
                media: { payload: combined.toString('base64'), format: 'pcm16', sample_rate: EXOTEL_SAMPLE_RATE }
            }));
        }
    }

    function discardOutBuffer() {
        outBuffer = [];
        outBufferSize = 0;
    }

    function cancelActiveResponse() {
        if (activeResponse && openAIWs.readyState === WebSocket.OPEN) {
            openAIWs.send(JSON.stringify({ type: 'response.cancel' }));
        }
        activeResponse = false;
        discardOutBuffer();
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

        // Enable server-side VAD — OpenAI detects speech/silence far more accurately
        // than an amplitude threshold, avoiding false interruptions during AI speech.
        openAIWs.send(JSON.stringify({
            type: 'session.update',
            session: {
                instructions: callConfig.systemInstructions,
                voice: callConfig.voice,
                input_audio_format: 'pcm16',
                output_audio_format: 'pcm16',
                turn_detection: {
                    type: 'server_vad',
                    threshold: callConfig.vadThreshold,
                    prefix_padding_ms: 300,
                    silence_duration_ms: callConfig.silenceTimeoutMs
                }
            }
        }));

        // Flush any audio that arrived before the connection was ready
        queuedChunks.forEach(chunk => {
            openAIWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') }));
        });
        queuedChunks = [];
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
            const audioChunk = Buffer.from(data.media.payload, 'base64');
            const resampled = resampleAudioChunk(audioChunk, EXOTEL_SAMPLE_RATE, OPENAI_SAMPLE_RATE);

            if (openAIWs.readyState === WebSocket.OPEN) {
                openAIWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: resampled.toString('base64') }));
            } else {
                queuedChunks.push(resampled);
            }

        } else if (data.event === 'start') {
            console.log('📡 Stream started:', data.start.stream_sid);

            // Trigger the initial greeting — no user audio needed, just ask for a response
            if (!initialGreetingSent && openAIWs.readyState === WebSocket.OPEN) {
                openAIWs.send(JSON.stringify({
                    type: 'response.create',
                    response: { modalities: ['audio', 'text'] }
                }));
                activeResponse = true;
                initialGreetingSent = true;
            }
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

        // User started speaking → barge-in: cancel AI response immediately
        if (data.type === 'input_audio_buffer.speech_started') {
            console.log('🎙️  User speaking — barge-in');
            cancelActiveResponse();
        }

        // AI response started
        if (data.type === 'response.created') {
            activeResponse = true;
        }

        // Stream audio delta: resample and batch before sending to Exotel
        if (data.type === 'response.audio.delta' && data.delta) {
            const chunk = Buffer.from(data.delta, 'base64');
            const resampled = resampleAudioChunk(chunk, OPENAI_SAMPLE_RATE, EXOTEL_SAMPLE_RATE);
            outBuffer.push(resampled);
            outBufferSize += resampled.length;
            flushOutBuffer(); // sends only when MIN_OUT_BYTES accumulated
        }

        // Response audio finished — flush any remaining buffered audio
        if (data.type === 'response.audio.done') {
            flushOutBuffer(true);
            activeResponse = false;
        }

        if (data.type === 'response.done') {
            activeResponse = false;
        }

        if (data.type === 'error') {
            console.error('*** OPENAI ERROR:', data.error?.message);
            activeResponse = false;
            discardOutBuffer();
        }
    });

    exotelWs.on('close', () => {
        console.log('❌ Exotel disconnected, cleaning up');
        openAIWs.close();
    });
});

server.listen(8080, () => {
    console.log('🚀 Server running on port 8080');
    console.log('   WebSocket: ws://YOUR_SERVER_IP:8080');
    console.log('   Config UI: http://YOUR_SERVER_IP:8080');
});
