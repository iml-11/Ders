// Yapay zeka sağlayıcıları ve ortak "chat" arayüzü.
// Tüm istekler doğrudan tarayıcıdan sağlayıcının API'sine gider.

const PROVIDERS = {
  openai: {
    name: 'OpenAI (ChatGPT)',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o-mini'],
    hint: 'Anahtarını platform.openai.com/api-keys adresinden alabilirsin.',
  },
  anthropic: {
    name: 'Anthropic (Claude)',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    hint: 'Anahtarını console.anthropic.com adresinden alabilirsin.',
  },
  gemini: {
    name: 'Google Gemini',
    type: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite'],
    hint: 'Ücretsiz anahtarı aistudio.google.com/apikey adresinden alabilirsin.',
  },
  openrouter: {
    name: 'OpenRouter (yüzlerce model)',
    type: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openai/gpt-5-mini', 'anthropic/claude-sonnet-5', 'google/gemini-2.5-flash', 'deepseek/deepseek-chat', 'meta-llama/llama-3.3-70b-instruct'],
    hint: 'Tek anahtarla birçok modele eriş: openrouter.ai/keys. Model adını "sağlayıcı/model" biçiminde yaz.',
  },
  groq: {
    name: 'Groq',
    type: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    hint: 'Çok hızlı ve ücretsiz katmanı var: console.groq.com/keys',
  },
  deepseek: {
    name: 'DeepSeek',
    type: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    hint: 'Anahtar: platform.deepseek.com (fotoğraf/görsel desteklemez).',
  },
  mistral: {
    name: 'Mistral',
    type: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-small-latest'],
    hint: 'Anahtar: console.mistral.ai',
  },
  ollama: {
    name: 'Ollama (bilgisayarında, ücretsiz)',
    type: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    models: ['llama3.1', 'qwen2.5', 'gemma2'],
    noKey: true,
    hint: 'Ollama\'yı OLLAMA_ORIGINS="*" ortam değişkeniyle başlat ki tarayıcı bağlanabilsin. Anahtar gerekmez.',
  },
  custom: {
    name: 'Özel (OpenAI uyumlu API)',
    type: 'openai',
    baseUrl: '',
    models: [],
    hint: 'OpenAI uyumlu herhangi bir API (LM Studio, Together, Fireworks, Azure vb.). Base URL ".../v1" ile bitmeli.',
  },
};

class AIError extends Error {}

function dataUrlParts(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  return m ? { mediaType: m[1], data: m[2] } : null;
}

// Görselleri ilk kullanıcı mesajına ekler; sağlayıcıya göre biçimlendirir.
function buildContent(type, text, images) {
  if (!images || !images.length) return null;
  if (type === 'anthropic') {
    return [
      ...images.map((u) => {
        const p = dataUrlParts(u);
        return { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } };
      }),
      { type: 'text', text },
    ];
  }
  if (type === 'gemini') {
    return [
      ...images.map((u) => {
        const p = dataUrlParts(u);
        return { inline_data: { mime_type: p.mediaType, data: p.data } };
      }),
      { text },
    ];
  }
  return [
    ...images.map((u) => ({ type: 'image_url', image_url: { url: u } })),
    { type: 'text', text },
  ];
}

// SSE akışını satır satır okur ve her "data:" satırı için callback çağırır.
async function readSSE(response, onData) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload) onData(payload);
      }
    }
  }
  const rest = buffer.trim();
  if (rest.startsWith('data:')) onData(rest.slice(5).trim());
}

async function readError(res) {
  let text = '';
  try { text = await res.text(); } catch (_) { /* yok say */ }
  let msg = text;
  try {
    const j = JSON.parse(text);
    msg = j.error?.message || j.error?.status || j.message || (typeof j.error === 'string' ? j.error : text);
  } catch (_) { /* düz metin */ }
  const hints = {
    401: 'API anahtarı geçersiz görünüyor.',
    403: 'Bu anahtarın bu modele/erişime izni yok.',
    404: 'Model adı veya API adresi yanlış olabilir.',
    429: 'Kota/limit aşıldı. Biraz bekleyip tekrar dene veya bakiyeni kontrol et.',
  };
  return new AIError(`HTTP ${res.status}${hints[res.status] ? ' – ' + hints[res.status] : ''}\n${msg || ''}`.trim());
}

/**
 * Ortak sohbet fonksiyonu.
 * @param {object} settings  { provider, apiKey, model, baseUrl, maxTokens }
 * @param {object} req       { system, messages: [{role:'user'|'assistant', content:string}], images, onToken, signal }
 * @returns {Promise<string>} Tüm cevap metni
 */
async function chat(settings, req) {
  const prov = PROVIDERS[settings.provider];
  if (!prov) throw new AIError('Sağlayıcı seçilmemiş. Ayarlardan bir yapay zeka seç.');
  if (!prov.noKey && !settings.apiKey && settings.provider !== 'custom') {
    throw new AIError('API anahtarı girilmemiş. Sağ üstteki ⚙️ Ayarlar\'dan anahtarını ekle.');
  }
  if (!settings.model) throw new AIError('Model adı girilmemiş. Ayarlardan bir model seç.');
  const baseUrl = (settings.baseUrl || prov.baseUrl || '').replace(/\/+$/, '');
  if (!baseUrl) throw new AIError('API adresi (Base URL) girilmemiş.');

  const onToken = req.onToken || (() => {});
  let full = '';
  const emit = (t) => { if (t) { full += t; onToken(t, full); } };

  // İlk kullanıcı mesajına görselleri ekle
  const firstUserIdx = req.messages.findIndex((m) => m.role === 'user');

  let res;
  try {
    if (prov.type === 'anthropic') {
      const messages = req.messages.map((m, i) => ({
        role: m.role,
        content: (i === firstUserIdx && buildContent('anthropic', m.content, req.images)) || m.content,
      }));
      res = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        signal: req.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': settings.apiKey,
          'anthropic-version': '2023-06-01',
          // Tarayıcıdan doğrudan erişim için gerekli (CORS)
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: settings.model,
          max_tokens: Number(settings.maxTokens) || 16000,
          system: req.system,
          messages,
          stream: true,
        }),
      });
      if (!res.ok) throw await readError(res);
      let stopReason = null;
      await readSSE(res, (payload) => {
        let ev;
        try { ev = JSON.parse(payload); } catch (_) { return; }
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') emit(ev.delta.text);
        else if (ev.type === 'message_delta' && ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        else if (ev.type === 'error') throw new AIError(ev.error?.message || 'Akış hatası');
      });
      if (stopReason === 'refusal') emit('\n\n> ⚠️ Model bu isteği yanıtlamayı reddetti.');
      if (stopReason === 'max_tokens') emit('\n\n> ⚠️ Cevap maksimum token sınırına ulaştı. Ayarlardan "Maks. çıktı token" değerini artırabilirsin.');
    } else if (prov.type === 'gemini') {
      const contents = req.messages.map((m, i) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: (i === firstUserIdx && buildContent('gemini', m.content, req.images)) || [{ text: m.content }],
      }));
      const body = { contents };
      if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
      if (settings.maxTokens) body.generationConfig = { maxOutputTokens: Number(settings.maxTokens) };
      res = await fetch(`${baseUrl}/models/${encodeURIComponent(settings.model)}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        signal: req.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': settings.apiKey },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw await readError(res);
      await readSSE(res, (payload) => {
        let ev;
        try { ev = JSON.parse(payload); } catch (_) { return; }
        if (ev.error) throw new AIError(ev.error.message || 'Akış hatası');
        const parts = ev.candidates?.[0]?.content?.parts || [];
        for (const p of parts) if (p.text && !p.thought) emit(p.text);
      });
    } else {
      // OpenAI uyumlu (OpenAI, OpenRouter, Groq, DeepSeek, Mistral, Ollama, özel)
      const messages = [];
      if (req.system) messages.push({ role: 'system', content: req.system });
      req.messages.forEach((m, i) => {
        messages.push({
          role: m.role,
          content: (i === firstUserIdx && buildContent('openai', m.content, req.images)) || m.content,
        });
      });
      const headers = { 'content-type': 'application/json' };
      if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
      if (settings.provider === 'openrouter') {
        headers['HTTP-Referer'] = location.origin;
        headers['X-Title'] = 'Ders Asistani';
      }
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        signal: req.signal,
        headers,
        body: JSON.stringify({ model: settings.model, messages, stream: true }),
      });
      if (!res.ok) throw await readError(res);
      await readSSE(res, (payload) => {
        if (payload === '[DONE]') return;
        let ev;
        try { ev = JSON.parse(payload); } catch (_) { return; }
        if (ev.error) throw new AIError(ev.error.message || 'Akış hatası');
        emit(ev.choices?.[0]?.delta?.content || '');
      });
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (err instanceof AIError) throw err;
    // fetch ağ/CORS hatası
    throw new AIError(
      `Bağlantı kurulamadı: ${err.message}\n` +
      'İnternet bağlantını, API adresini kontrol et. Ollama kullanıyorsan OLLAMA_ORIGINS="*" ile başlattığından emin ol.'
    );
  }

  if (!full.trim()) throw new AIError('Model boş bir cevap döndürdü. Farklı bir model deneyebilirsin.');
  return full;
}

window.AI = { PROVIDERS, chat, AIError };
