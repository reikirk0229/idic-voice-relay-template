const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');
const express = require('express');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_JSON_MB = Math.max(1, Number(process.env.MAX_JSON_MB || 12));
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.REQUEST_TIMEOUT_MS || 190000));
const ALIYUN_TIMEOUT_MS = Math.max(5000, Number(process.env.ALIYUN_TIMEOUT_MS || 180000));
const TENCENT_TIMEOUT_MS = Math.max(5000, Number(process.env.TENCENT_TIMEOUT_MS || 20000));
const RELAY_TOKEN = String(process.env.IDIC_RELAY_TOKEN || '').trim();

app.use(cors());
app.use(express.json({ limit: `${MAX_JSON_MB}mb` }));

function sendJson(res, statusCode, body) {
  res.status(statusCode).json(body);
}

function isPublicHealthPath(req) {
  return req.method === 'GET' && req.path === '/health';
}

function requireRelayToken(req, res, next) {
  if (isPublicHealthPath(req) || !RELAY_TOKEN) {
    next();
    return;
  }
  const auth = String(req.headers.authorization || '').trim();
  const token = auth.replace(/^Bearer\s+/i, '').trim() || String(req.headers['x-idic-relay-token'] || '').trim();
  if (token !== RELAY_TOKEN) {
    sendJson(res, 401, { ok: false, error: 'Invalid relay token' });
    return;
  }
  next();
}

app.use(requireRelayToken);

function trimText(value, maxLength = 2000) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function sha256Hex(message) {
  return crypto.createHash('sha256').update(message, 'utf8').digest('hex');
}

function hmacSha256(key, message) {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest();
}

function getTc3Signature(secretKey, date, service, stringToSign) {
  const kDate = hmacSha256(`TC3${secretKey}`, date);
  const kService = hmacSha256(kDate, service);
  const kSigning = hmacSha256(kService, 'tc3_request');
  return crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
}

function extractContentText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part) return '';
      if (typeof part === 'string') return part;
      return part.text || part.output_text || part.content || '';
    }).filter(Boolean).join('');
  }
  if (typeof content === 'object') {
    return content.text || content.output_text || content.content || '';
  }
  return '';
}

function extractCompletionText(data) {
  const safeData = data && typeof data === 'object' ? data : {};
  const choices = Array.isArray(safeData.choices) ? safeData.choices : [];
  const choice = choices[0] || {};
  return trimText(
    extractContentText(choice.message && choice.message.content)
    || extractContentText(choice.delta && choice.delta.content)
    || safeData.output_text
    || safeData.text
    || '',
    12000
  );
}

function parseJsonMaybe(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const candidates = [
    raw,
    raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  ];
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (error) {
      // Keep trying.
    }
  }
  return null;
}

function normalizeChatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${trimmed}/chat/completions`;
}

function normalizeAudioData(audioBase64) {
  const raw = String(audioBase64 || '').trim();
  if (!raw) return '';
  return raw.startsWith('data:') ? raw : `data:;base64,${raw}`;
}

function isCaptionerModel(model) {
  return /captioner/i.test(String(model || ''));
}

function shouldStreamModel(model) {
  const lower = String(model || '').toLowerCase();
  return /omni/.test(lower) && !/captioner/.test(lower);
}

function buildAliyunPrompt(prompt, transcript, localMeta) {
  const parts = [trimText(prompt || '', 1200)].filter(Boolean);
  const transcriptText = trimText(transcript, 800);
  if (transcriptText) parts.push(`Transcript: ${transcriptText}`);
  if (localMeta && typeof localMeta === 'object') {
    const localSummary = {
      summary: localMeta.summary,
      environment: localMeta.environment,
      pace: localMeta.pace && localMeta.pace.label,
      pauses: localMeta.pauses && localMeta.pauses.label,
      volume: localMeta.volume && localMeta.volume.label,
      prosody: localMeta.prosody,
      emotion: localMeta.emotion,
      delivery: localMeta.delivery
    };
    parts.push(`Local acoustic estimate for reference: ${trimText(JSON.stringify(localSummary), 1000)}`);
  }
  return parts.join('\n');
}

function buildAliyunPayload({ model, audioData, audioFormat, promptText, stream }) {
  const captionerModel = isCaptionerModel(model);
  const audioPart = {
    type: 'input_audio',
    input_audio: { data: audioData }
  };
  if (!captionerModel && audioFormat) {
    audioPart.input_audio.format = audioFormat || 'wav';
  }
  const content = [audioPart];
  if (!captionerModel && promptText) {
    content.push({ type: 'text', text: promptText });
  }
  const payload = {
    model,
    messages: [{ role: 'user', content }]
  };
  if (!captionerModel) {
    payload.temperature = 0.2;
  }
  if (stream) {
    payload.stream = true;
    payload.stream_options = { include_usage: true };
    payload.modalities = ['text'];
  }
  return payload;
}

function streamToString(stream) {
  return new Promise((resolve, reject) => {
    let text = '';
    stream.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    stream.on('end', () => resolve(text));
    stream.on('error', reject);
  });
}

function collectSseCompletion(stream) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let text = '';
    const events = [];
    const appendContent = (content) => {
      const chunkText = extractContentText(content);
      if (chunkText) text += chunkText;
    };
    const consumeLine = (line) => {
      const trimmed = String(line || '').trim();
      if (!trimmed.startsWith('data:')) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        events.push(json);
        const choice = Array.isArray(json.choices) ? json.choices[0] : null;
        if (choice) {
          appendContent(choice.delta && choice.delta.content);
          appendContent(choice.message && choice.message.content);
        }
        appendContent(json.output_text || json.text || '');
      } catch (error) {
        text += payload;
      }
    };
    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach(consumeLine);
    });
    stream.on('end', () => {
      if (buffer) buffer.split(/\r?\n/).forEach(consumeLine);
      resolve({ text: trimText(text, 12000), rawEvents: events.slice(-20) });
    });
    stream.on('error', reject);
  });
}

async function callTencentAsr(body) {
  const raw = body && typeof body === 'object' ? body : {};
  const secretId = String(raw.secretId || process.env.TENCENT_SECRET_ID || '').trim();
  const secretKey = String(raw.secretKey || process.env.TENCENT_SECRET_KEY || '').trim();
  const region = String(raw.region || process.env.TENCENT_REGION || '').trim();
  const engServiceType = String(raw.engServiceType || process.env.TENCENT_ASR_ENGINE || '16k_zh').trim();
  const voiceFormat = String(raw.voiceFormat || process.env.TENCENT_VOICE_FORMAT || 'wav').trim();
  const data = raw.data;
  const dataLen = raw.dataLen;
  const subServiceType = Number(raw.subServiceType ?? process.env.TENCENT_SUB_SERVICE_TYPE);
  const projectId = Number(raw.projectId ?? process.env.TENCENT_PROJECT_ID);

  if (!secretId || !secretKey || !data || !dataLen) {
    const error = new Error('缺少腾讯 ASR 必要参数');
    error.statusCode = 400;
    throw error;
  }

  const host = 'asr.tencentcloudapi.com';
  const service = 'asr';
  const action = 'SentenceRecognition';
  const version = '2019-06-14';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const payload = {
    SubServiceType: Number.isFinite(subServiceType) ? subServiceType : 2,
    ProjectId: Number.isFinite(projectId) ? projectId : 0,
    EngSerViceType: engServiceType || '16k_zh',
    SourceType: 1,
    VoiceFormat: voiceFormat || 'wav',
    Data: data,
    DataLen: dataLen
  };
  const payloadJson = JSON.stringify(payload);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(payloadJson)
  ].join('\n');
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256',
    timestamp,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join('\n');
  const signature = getTc3Signature(secretKey, date, service, stringToSign);
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    Host: host,
    'X-TC-Action': action,
    'X-TC-Version': version,
    'X-TC-Timestamp': timestamp.toString(),
    Authorization: authorization
  };
  if (region) headers['X-TC-Region'] = region;

  const response = await axios.post(`https://${host}/`, payloadJson, {
    headers,
    timeout: TENCENT_TIMEOUT_MS,
    validateStatus: () => true
  });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(typeof response.data === 'string' ? response.data : JSON.stringify(response.data));
    error.statusCode = response.status;
    error.details = response.data;
    throw error;
  }
  return response.data;
}

async function callAliyunUnderstanding(body) {
  const apiKey = String(body.apiKey || '').trim() || String(process.env.ALIYUN_API_KEY || '').trim();
  const model = String(body.model || process.env.ALIYUN_MODEL || 'qwen3-omni-30b-a3b-captioner').trim();
  const baseUrl = String(body.baseUrl || process.env.ALIYUN_BASE_URL || '').trim();
  const audioData = normalizeAudioData(body.audioBase64);
  const audioFormat = String(body.audioFormat || 'wav').trim().toLowerCase() || 'wav';
  if (!apiKey || !audioData) {
    const error = new Error('缺少阿里云 API Key 或音频数据');
    error.statusCode = 400;
    throw error;
  }
  const stream = shouldStreamModel(model);
  const payload = buildAliyunPayload({
    model,
    audioData,
    audioFormat,
    promptText: buildAliyunPrompt(body.prompt, body.transcript, body.localMeta),
    stream
  });
  const response = await axios.post(normalizeChatCompletionsUrl(baseUrl), payload, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    timeout: ALIYUN_TIMEOUT_MS,
    maxBodyLength: Infinity,
    responseType: stream ? 'stream' : 'json',
    validateStatus: () => true
  });
  if (response.status < 200 || response.status >= 300) {
    const details = stream ? await streamToString(response.data) : response.data;
    const error = new Error(details && typeof details === 'object' ? JSON.stringify(details) : String(details || `DashScope ${response.status}`));
    error.statusCode = response.status;
    error.details = details;
    throw error;
  }
  if (stream) {
    const streamResult = await collectSseCompletion(response.data);
    return { text: streamResult.text, raw: streamResult.rawEvents, model };
  }
  return { text: extractCompletionText(response.data), raw: response.data, model };
}

function errorResponse(error, fallbackStatus = 500) {
  const statusCode = Number(error && error.statusCode) || fallbackStatus;
  return {
    ok: false,
    error: error && error.message ? error.message : String(error || 'Unknown error'),
    details: error && error.details ? error.details : null
  };
}

app.get('/health', (req, res) => {
  sendJson(res, 200, {
    ok: true,
    service: 'idic-voice-relay',
    version: '0.1.0',
    tokenRequired: Boolean(RELAY_TOKEN)
  });
});

app.post('/asr/tencent', async (req, res) => {
  try {
    const data = await callTencentAsr(req.body || {});
    sendJson(res, 200, data);
  } catch (error) {
    sendJson(res, Number(error.statusCode) || 500, errorResponse(error));
  }
});

app.post('/audio/aliyun-understanding', async (req, res) => {
  try {
    const result = await callAliyunUnderstanding(req.body || {});
    const text = trimText(result.text, 12000);
    if (!text) {
      sendJson(res, 502, {
        ok: false,
        error: 'Aliyun audio understanding returned empty text',
        details: result.raw || null
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      provider: 'aliyun',
      model: result.model,
      text,
      parsed: parseJsonMaybe(text),
      raw: result.raw
    });
  } catch (error) {
    sendJson(res, Number(error.statusCode) || 500, errorResponse(error));
  }
});

app.post('/voice/process', async (req, res) => {
  const body = req.body || {};
  const warnings = [];
  const [asrResult, aliyunResult] = await Promise.allSettled([
    callTencentAsr(body.tencentAsr || body),
    callAliyunUnderstanding(body.aliyun || body)
  ]);
  const response = {
    ok: true,
    transcript: '',
    asr: null,
    enhancedMeta: null,
    warnings
  };
  if (asrResult.status === 'fulfilled') {
    response.asr = asrResult.value;
    response.transcript = asrResult.value && asrResult.value.Response ? (asrResult.value.Response.Result || '') : '';
  } else {
    response.ok = false;
    warnings.push({ source: 'tencent_asr', error: asrResult.reason && asrResult.reason.message ? asrResult.reason.message : String(asrResult.reason) });
  }
  if (aliyunResult.status === 'fulfilled') {
    const text = trimText(aliyunResult.value.text, 12000);
    response.enhancedMeta = {
      provider: 'aliyun',
      model: aliyunResult.value.model,
      text,
      parsed: parseJsonMaybe(text),
      raw: aliyunResult.value.raw
    };
  } else {
    warnings.push({ source: 'aliyun_understanding', error: aliyunResult.reason && aliyunResult.reason.message ? aliyunResult.reason.message : String(aliyunResult.reason) });
  }
  sendJson(res, response.ok ? 200 : 502, response);
});

app.use((error, req, res, next) => {
  if (error && error.type === 'entity.too.large') {
    sendJson(res, 413, { ok: false, error: `请求体太大，请调高 MAX_JSON_MB 或缩短语音。当前限制 ${MAX_JSON_MB}MB。` });
    return;
  }
  next(error);
});

app.listen(PORT, () => {
  console.log(`[idic-voice-relay] listening on ${PORT}`);
}).setTimeout(REQUEST_TIMEOUT_MS);
