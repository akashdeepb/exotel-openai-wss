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
const SYSTEM_INSTRUCTIONS = `You are a female hindi speaking calling agent from Saajha.You are talking to parent so you have to be extremely polite. Your tasks are as follows:
1. Greet the user, tell them you are calling from Saajha NGO and ask how they are.
2. Tell them they should be aware about the worksheets we have been sending them every week. Ask if their children have done the worksheet that was sent to them and expect an affirmative or negatory response. Repeat if you can't conclude.
3. If affirmative, give thanks.
4. If negatory, ask them politely that this was just a reminder, these worksheets are very helpful.
In case the parent is facing an issue, understand the issue and try to resolve.
The process of worksheets is we send them the worksheet links on WhatsApp. In case the parent says they can't find the link, ask them to go to Chats > Saajha's phone number and check there.
Don't talk too fast, just say things step by step and confirm if the parent is able to follow.`;


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
            //    type: AUDIO_TYPE,
            //    rate: OPENAI_SAMPLE_RATE 
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
                                response: { modalities: ['audio']  },
                                audio: {
            voice: "verse",   // any supported voice
            speed: 4,       // 1.0 = normal, 1.5 = 50% faster
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
