const WebSocket = require('ws');
const http = require('http');
require('dotenv').config();

// --- Configuration Constants ---
const EXOTEL_SAMPLE_RATE = 8000;
const OPENAI_SAMPLE_RATE = 24000;
const AUDIO_TYPE = 'audio/pcm'; 
const SILENCE_TIMEOUT_MS = 2500; 
const SILENCE_THRESHOLD = 500; 
// ------------------------------

// --- Audio Resampling Function (Linear Interpolation) ---
function resampleAudioChunk(inputBuffer, inputSampleRate, outputSampleRate) {
    // ... (resampling function remains unchanged) ...
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

        const resampledValue = sample1 + (sample2 - sample1) * fraction;
        outputBuffer.writeInt16LE(Math.round(resampledValue), i * 2);
    }

    return outputBuffer;
}

// --- Volume-Based VAD Function ---
function isSilence(audioBuffer, threshold) {
    // ... (isSilence function remains unchanged) ...
    for (let i = 0; i < audioBuffer.length; i += 2) {
        const sample = audioBuffer.readInt16LE(i);
        if (Math.abs(sample) > threshold) return false;
    }
    return true;
}

// --- Agent System Prompt ---
// --- Agent System Prompt ---
const SYSTEM_INSTRUCTIONS = `# PERSONALITY & ROLE
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
- Keep it conversational and friendly`;

// ----------------- Server -----------------
const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', (exotelWs) => {
    console.log('📞 Exotel connected!');

    let silenceTimer = null;
    let isUserSpeaking = false;
    let activeResponse = false;
    let queuedChunks = [];
    let initialGreetingSent = false;
    let lastUserTranscript = null;

    // Initialize history with the System Prompt
    const conversationHistory = [{
        role: 'system',
        content: SYSTEM_INSTRUCTIONS
    }];

    const openAIWs = new WebSocket(
        'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
        {
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'OpenAI-Beta': 'realtime=v1'
            }
        }
    );

    openAIWs.audioBuffer = [];
    openAIWs.bytesAppended = 0;

    openAIWs.on('open', () => {
        console.log('✅ Connected to OpenAI Realtime API');
        
        // ** FIX APPLIED: Removed the conflicting 'session: { instructions: ... }' block **
        openAIWs.send(JSON.stringify({ 
            type: 'session.update',
            //audio_format: { 
            //    type: AUDIO_TYPE,
            //    rate: OPENAI_SAMPLE_RATE 
            //},
            session: {
                //type: "realtime",
                instructions: SYSTEM_INSTRUCTIONS
            }
        }));

        // Flush queued audio chunks
        queuedChunks.forEach(chunk => {
            openAIWs.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: chunk.toString('base64')
            }));
            openAIWs.bytesAppended += chunk.length;
        });
        queuedChunks = [];
    });

    openAIWs.on('error', (err) => {
        console.error('*** OPENAI WS ERROR:', err.message);
    });

    openAIWs.on('close', () => {
        console.log('❌ OpenAI disconnected');
        if (exotelWs.readyState === WebSocket.OPEN) exotelWs.close();
    });

    exotelWs.on('message', (message) => {
        const data = JSON.parse(message.toString());

        if (data.event === 'media') {
            const audioChunk = Buffer.from(data.media.payload, 'base64');
            const resampledChunk = resampleAudioChunk(
                audioChunk,
                EXOTEL_SAMPLE_RATE,
                OPENAI_SAMPLE_RATE
            );

            if (openAIWs.readyState === WebSocket.OPEN) {
                openAIWs.send(JSON.stringify({
                    type: 'input_audio_buffer.append',
                    audio: resampledChunk.toString('base64')
                }));
                openAIWs.bytesAppended += resampledChunk.length;
            } else {
                queuedChunks.push(resampledChunk);
            }

            // --- VAD Logic ---
            const speaking = !isSilence(audioChunk, SILENCE_THRESHOLD);
            if (speaking) {
                //if (!isUserSpeaking) //console.log('🎙️ User started speaking, interrupting AI...');
                isUserSpeaking = true;

                if (activeResponse) {
                    openAIWs.send(JSON.stringify({ type: 'response.cancel' }));
                    activeResponse = false;
                }

                if (silenceTimer) clearTimeout(silenceTimer);
            } else {
                if (isUserSpeaking) {
                    silenceTimer = setTimeout(() => {
                        //console.log('🤫 User silent → AI responds');

                        if (!activeResponse && openAIWs.bytesAppended > (OPENAI_SAMPLE_RATE * 0.1 * 2)) {
                            
                            openAIWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

                            // Send the FULL conversation history (including the system role)
                            openAIWs.send(JSON.stringify({ 
                                type: 'response.create', 
                                //messages: conversationHistory, 
                                response: { modalities: ['audio', 'text']  },
                                audio: {
            voice: "verse",   // any supported voice
            speed: 4,       // 1.0 = normal, 1.5 = 50% faster
        },
        instructions: "Speak fluently and quickly, like a friendly narrator."
                            }));
                            
                            activeResponse = true;
                            openAIWs.bytesAppended = 0;
                        }
                        isUserSpeaking = false;
                        silenceTimer = null;
                    }, SILENCE_TIMEOUT_MS);
                }
            }
        } else if (data.event === 'start') {
            console.log('📡 Stream started for call:', data.start.stream_sid);
            
            // Initiate the first response (The GREETING)
            if (!initialGreetingSent && openAIWs.readyState === WebSocket.OPEN) {
                openAIWs.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); 
                
                // Send response.create with the system prompt to trigger the initial greeting
                openAIWs.send(JSON.stringify({ 
                    type: 'response.create', 
                    messages: conversationHistory,
                    response: { modalities: ['audio', 'text'] }
                }));
                activeResponse = true;
                initialGreetingSent = true;
            }
        }
    });

    openAIWs.on('message', (message) => {
        let data;
        const messageStr = Buffer.isBuffer(message) ? message.toString() : message;

        try {
            data = JSON.parse(messageStr);
        } catch (e) {
            console.error('*** OPENAI PARSE ERROR:', e);
            return;
        }

        if (data.type === 'response.audio.delta' && data.delta) {
            const chunk = Buffer.from(data.delta, 'base64');
            openAIWs.audioBuffer.push(chunk);
        }

        if (data.type === 'response.transcript') {
            if (data.role === 'user' && data.text) {
                 lastUserTranscript = data.text;
                 //console.log(`[USER]: ${data.text}`);
            }
        }

        if (data.type === 'response.audio.done') {
            const fullAudio = Buffer.concat(openAIWs.audioBuffer);
            openAIWs.audioBuffer = [];

            if (exotelWs.readyState === WebSocket.OPEN && fullAudio.length > 0) {
                const resampledBack = resampleAudioChunk(
                    fullAudio,
                    OPENAI_SAMPLE_RATE,
                    EXOTEL_SAMPLE_RATE
                );

                exotelWs.send(JSON.stringify({
                    event: 'media',
                    media: {
                        payload: resampledBack.toString('base64'),
                        format: 'pcm16',
                        sample_rate: EXOTEL_SAMPLE_RATE
                    }
                }));
                //console.log(`✅ Sent ${resampledBack.length} bytes to Exotel`);
            }
            activeResponse = false;
        }

        if (data.type === 'response.done') {
            // Update history with the user's input and AI's response after a turn
            if (lastUserTranscript) {
                conversationHistory.push({ role: 'user', content: lastUserTranscript });
                lastUserTranscript = null;
            }
            
            if (data.text) {
                conversationHistory.push({ role: 'assistant', content: data.text });
                //console.log(`[AI TEXT]: ${data.text}`);
            }
            activeResponse = false;
            //console.log('🗣️ OpenAI finished speaking');
        }

        if (data.type === 'error') {
            console.error('*** OPENAI ERROR:', data.error?.message);
            activeResponse = false;
        }
    });

    exotelWs.on('close', () => {
        console.log('❌ Exotel disconnected, cleaning up');
        if (silenceTimer) clearTimeout(silenceTimer);
        openAIWs.close();
    });
});

server.listen(8080, () => {
    console.log('🚀 Exotel WebSocket Server running on port 8080');
    console.log('Waiting for connection at ws://YOUR_SERVER_IP:8080');
});
