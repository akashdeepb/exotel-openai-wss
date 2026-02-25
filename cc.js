const express = require('express');
const WebSocket = require('ws');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 8081;

// Store active call sessions
const activeSessions = new Map();

// Exotel webhook endpoint - receives incoming call
app.post('/webhook/incoming-call', (req, res) => {
  const { CallSid, From, To } = req.body;
  
  console.log(`Incoming call from ${From} to ${To}, CallSid: ${CallSid}`);
  
  // Respond with Exotel XML to connect the call to WebSocket stream
  const response = `
    <?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Say>Please wait while we connect you to our AI assistant.</Say>
      <Connect>
        <Stream url="wss://${req.get('host')}/media-stream/${CallSid}" />
      </Connect>
    </Response>
  `;
  
  res.type('text/xml');
  res.send(response);
});

// WebSocket server for handling media streams
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', async (ws, req) => {
  const callSid = req.url.split('/').pop();
  console.log(`WebSocket connected for call: ${callSid}`);
  
  // Connect to OpenAI Realtime API
  const openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });
  
  // Store session
  activeSessions.set(callSid, { exotelWs: ws, openaiWs: openaiWs });
  
  // Configure OpenAI session
  openaiWs.on('open', () => {
    console.log('Connected to OpenAI Realtime API');
    
    // Send session configuration
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: 'You are a helpful AI assistant on a phone call. Be conversational, friendly, and concise.',
        voice: 'alloy',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: {
          model: 'whisper-1'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500
        }
      }
    }));
  });
  
  // Handle messages from Exotel (audio from caller)
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      
      if (msg.event === 'media' && msg.media) {
        // Forward audio to OpenAI
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload
        }));
      }
      
      if (msg.event === 'start') {
        console.log('Stream started:', msg.start);
      }
      
      if (msg.event === 'stop') {
        console.log('Stream stopped');
        openaiWs.close();
      }
    } catch (error) {
      console.error('Error processing Exotel message:', error);
    }
  });
  
  // Handle messages from OpenAI (audio responses)
  openaiWs.on('message', (message) => {
    try {
      const response = JSON.parse(message);
      
      if (response.type === 'response.audio.delta' && response.delta) {
        // Send audio back to caller via Exotel
        ws.send(JSON.stringify({
          event: 'media',
          streamSid: callSid,
          media: {
            payload: response.delta
          }
        }));
      }
      
      if (response.type === 'conversation.item.input_audio_transcription.completed') {
        console.log('User said:', response.transcript);
      }
      
      if (response.type === 'response.done') {
        console.log('Response completed');
      }
      
      if (response.type === 'error') {
        console.error('OpenAI error:', response.error);
      }
    } catch (error) {
      console.error('Error processing OpenAI message:', error);
    }
  });
  
  // Handle disconnections
  ws.on('close', () => {
    console.log(`WebSocket closed for call: ${callSid}`);
    openaiWs.close();
    activeSessions.delete(callSid);
  });
  
  openaiWs.on('close', () => {
    console.log('OpenAI WebSocket closed');
    ws.close();
  });
  
  openaiWs.on('error', (error) => {
    console.error('OpenAI WebSocket error:', error);
    ws.close();
  });
  
  ws.on('error', (error) => {
    console.error('Exotel WebSocket error:', error);
    openaiWs.close();
  });
});

// Upgrade HTTP server to handle WebSocket connections
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Webhook URL: http://localhost:${PORT}/webhook/incoming-call`);
});

server.on('upgrade', (request, socket, head) => {
  if (request.url.startsWith('/media-stream/')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
