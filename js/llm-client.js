/**
 * LLMClient — LLM API 封装
 * 使用 DeepSeek，Key 内置，用户打开即玩
 */
const LLMClient = (() => {

  const BASE_URL = 'https://api.deepseek.com';
  const MODEL    = 'deepseek-chat';
  const API_KEY  = 'sk-e586da4b09124ba89c1c989599caec44';

  // ── 非流式：返回解析好的 JSON 对象 ───────────────────────
  async function chat(messages) {
    const resp = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.85,
        max_tokens: 1500,
        response_format: { type: 'json_object' }
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`API 错误 ${resp.status}: ${err}`);
    }

    const data = await resp.json();
    const content = data.choices[0].message.content;
    return JSON.parse(content);
  }

  // ── 流式：逐字符回调，返回完整文本 ──────────────────────
  async function chatStream(messages, onChunk, onDone) {
    const resp = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.85,
        max_tokens: 500,
        stream: true
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`API 错误 ${resp.status}: ${err}`);
    }

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let buffer   = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 保留末尾不完整行

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);
        if (jsonStr.trim() === '[DONE]') continue;
        try {
          const parsed = JSON.parse(jsonStr);
          const delta  = parsed.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullText += delta;
            onChunk(delta);
          }
        } catch (e) { /* 忽略解析异常 */ }
      }
    }

    if (onDone) onDone(fullText);
    return fullText;
  }

  return { chat, chatStream, API_KEY };
})();
