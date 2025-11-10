// Using 'ws' and a resampler like '@purinton/resampler' or by using a dedicated
// audio processing library (often requiring native bindings like 'soxr' or 'ffmpeg').
// For simplicity, we'll assume a working resampler function: 'resampleAudioChunk(chunk, inRate, outRate)'

const WebSocket = require('ws');
const http = require('http');

// Exotel sends 8kHz s16le PCM audio. OpenAI requires 24kHz PCM.

const EXOTEL_SAMPLE_RATE = 8000;
const OPENAI_SAMPLE_RATE = 24000;
// Exotel WSS Server
const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on('connection', function connection(exotelWs, req) {
    console.log('Exotel connected!');
    // 1. Establish connection to OpenAI Realtime API for this session
    const openAIWs = new WebSocket(
        'wss://api.openai.com/v1/realtime?model=gpt-realtime',
        { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } }
    );
    
    // Start session on OpenAI connection
    openAIWs.on('open', () => {
        console.log('Connected to OpenAI!');
        // Initialize the conversation on the OpenAI side
        openAIWs.send(JSON.stringify({
            event: 'session.create',
            // You need to replace 'gpt-realtime' with your desired model name
            model: 'gpt-realtime', 
            // The initial system prompt to set the bot's persona
            config: {
                system_prompt: 'You are a helpful and friendly voice assistant.', 
                input_audio_format: { 
                    sample_rate: 24000, 
                    channels: 1, 
                    type: 'int16' 
                }
            }
        }));
    });
    
    // --- Incoming Audio (Exotel -> OpenAI) ---
    exotelWs.on('message', function incoming(message) {
        const data = JSON.parse(message);

        if (data.event === 'media') {
            const audioChunk = Buffer.from(data.payload, 'base64');
            
            // **CRITICAL STEP:** Resample 8kHz audio to 24kHz
            const resampledChunk = resampleAudioChunk(
                audioChunk,
                EXOTEL_SAMPLE_RATE, 
                OPENAI_SAMPLE_RATE
            );
            
            // Send the resampled audio to OpenAI
            openAIWs.send(JSON.stringify({ 
                event: 'input_audio_buffer.append',
                data: resampledChunk.toString('base64'), 
                format: { sample_rate: OPENAI_SAMPLE_RATE, channels: 1, type: 'int16' }
            }));
            
            // You'll also need logic to detect silence/end of speech (VAD)
            // and then send the 'input_audio_buffer.commit' and 'response.create' 
            // events to OpenAI to trigger a response.
        } else if (data.event === 'start') {
            console.log('Exotel stream started for call SID:', data.stream_sid);
            // Send session/prompt to OpenAI to start the first greeting
        }
    });

    // --- Outgoing Audio (OpenAI -> Exotel) ---
    openAIWs.on('message', function incoming(message) {
        const data = JSON.parse(message);

        if (data.event === 'response.output_audio') {
            const openAIAudio = Buffer.from(data.data, 'base64');
            
            // **CRITICAL STEP:** Resample 24kHz audio back to 8kHz
            const resampledChunk = resampleAudioChunk(
                openAIAudio,
                OPENAI_SAMPLE_RATE, 
                EXOTEL_SAMPLE_RATE
            );

            // Send the 8kHz audio chunk back to Exotel
            exotelWs.send(JSON.stringify({
                event: 'media',
                payload: resampledChunk.toString('base64')
            }));
        } else if (data.event === 'response.done') {
            console.log('OpenAI response finished:', data.text);
            // You might want to send a 'clear' event back to Exotel here
            // to indicate the end of the bot's speaking turn.
        }
    });
    
    // Handle disconnections and errors gracefully on both sides
    exotelWs.on('close', () => openAIWs.close());
    openAIWs.on('close', () => exotelWs.close());
});

server.listen(8080, () => {
    console.log('Exotel WebSocket Server running on wss://localhost:8080');
});
