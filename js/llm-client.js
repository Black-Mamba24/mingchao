/**
 * LLMClient — LLM API 封装
 * 使用 DeepSeek，Key 内置，用户打开即玩
 */
const LLMClient = (() => {

  const BASE_URL = 'https://api.deepseek.com';
  const MODEL    = 'deepseek-chat';
  const API_KEY  = 'sk-e586da4b09124ba89c1c989599caec44';

  const SCENE_MAX_TOKENS  = 8000;
  const STREAM_MAX_TOKENS = 8000;

  function extractJsonObject(text) {
    const source = (text || '').trim();
    if (!source) throw new Error('模型返回了空内容');
    if (source.startsWith('{') && source.endsWith('}')) return source;

    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') {
        if (depth === 0) start = i;
        depth += 1;
        continue;
      }
      if (char === '}') {
        if (depth === 0) continue;
        depth -= 1;
        if (depth === 0 && start !== -1) {
          return source.slice(start, i + 1);
        }
      }
    }

    return source;
  }

  function createDebugSnippet(text, limit = 1200) {
    const source = (text || '').replace(/\s+/g, ' ').trim();
    if (!source) return '（空内容）';
    return source.length > limit ? `${source.slice(0, limit)}…` : source;
  }

  function repairTruncatedJson(text) {
    const source = (text || '').trim();
    if (!source) return source;

    const startIdx = source.indexOf('{');
    if (startIdx === -1) return source;

    const stack = [];
    let inString = false;
    let escaped = false;

    for (let i = startIdx; i < source.length; i += 1) {
      const char = source[i];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') { escaped = true; continue; }
        if (char === '"') { inString = false; }
        continue;
      }

      if (char === '"') { inString = true; continue; }
      if (char === '{') { stack.push('}'); continue; }
      if (char === '[') { stack.push(']'); continue; }
      if (char === '}' || char === ']') {
        const expected = stack[stack.length - 1];
        if (expected === char) {
          stack.pop();
        }
        continue;
      }
    }

    if (stack.length === 0 && !inString) return source;

    let truncated = source;

    if (inString) {
      let cutoff = truncated.length - 1;
      while (cutoff >= startIdx) {
        const ch = truncated[cutoff];
        if (ch === ',' || ch === '[' || ch === '{' || ch === ':') break;
        cutoff -= 1;
      }
      if (cutoff < startIdx) return source;
      truncated = truncated.slice(0, cutoff).replace(/[\s,]+$/, '');
      inString = false;
    }

    const rebuiltStack = [];
    let stringMode = false;
    let esc = false;
    for (let i = startIdx; i < truncated.length; i += 1) {
      const c = truncated[i];
      if (stringMode) {
        if (esc) { esc = false; continue; }
        if (c === '\\') { esc = true; continue; }
        if (c === '"') stringMode = false;
        continue;
      }
      if (c === '"') { stringMode = true; continue; }
      if (c === '{') rebuiltStack.push('}');
      else if (c === '[') rebuiltStack.push(']');
      else if (c === '}' || c === ']') {
        if (rebuiltStack[rebuiltStack.length - 1] === c) rebuiltStack.pop();
      }
    }

    if (stringMode) truncated += '"';
    truncated = truncated.replace(/[\s,]+$/, '');

    while (rebuiltStack.length > 0) {
      truncated += rebuiltStack.pop();
    }

    return truncated;
  }

  function tryParseWithRepair(rawText) {
    const extracted = extractJsonObject(rawText);
    try {
      return { ok: true, value: JSON.parse(extracted), usedRepair: false };
    } catch (firstError) {
      try {
        const repaired = repairTruncatedJson(extracted);
        return { ok: true, value: JSON.parse(repaired), usedRepair: true };
      } catch (repairError) {
        return { ok: false, error: firstError, repairError };
      }
    }
  }

  function buildParseError(message, rawContent, repairedContent = '') {
    const parts = [message, `原始返回片段：${createDebugSnippet(rawContent)}`];
    if (repairedContent) parts.push(`重试返回片段：${createDebugSnippet(repairedContent)}`);
    const error = new Error(parts.join('\n'));
    error.rawContent = rawContent || '';
    error.repairedContent = repairedContent || '';
    return error;
  }

  async function requestJson(messages, temperature = 0.85) {
    const resp = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature,
        max_tokens: SCENE_MAX_TOKENS,
        response_format: { type: 'json_object' }
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`API 错误 ${resp.status}: ${err}`);
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
  }

  function buildRepairMessages(messages, malformedContent) {
    const sourceMessages = messages.map(msg => ({ role: msg.role, content: msg.content }));
    return [
      {
        role: 'system',
        content: '你是一个 JSON 修复器。你必须根据原始任务重新输出一个严格合法的 JSON 对象。只输出 JSON，不要解释，不要 markdown，不要代码块。所有字符串必须正确闭合，所有属性名必须使用双引号。'
      },
      {
        role: 'user',
        content: `原始请求消息如下：\n${JSON.stringify(sourceMessages, null, 2)}\n\n上一次模型输出了损坏的 JSON，请基于同一请求重新生成完整、闭合、可被 JSON.parse 解析的 JSON。\n\n损坏输出如下：\n${malformedContent}`
      }
    ];
  }

  // ── 非流式：返回解析好的 JSON 对象 ───────────────────────
  async function chat(messages) {
    const firstContent = await requestJson(messages, 0.85);
    const firstAttempt = tryParseWithRepair(firstContent);
    if (firstAttempt.ok) return firstAttempt.value;

    const repairedContent = await requestJson(buildRepairMessages(messages, firstContent), 0.2);
    const secondAttempt = tryParseWithRepair(repairedContent);
    if (secondAttempt.ok) return secondAttempt.value;

    throw buildParseError(
      `JSON解析失败：${firstAttempt.error.message}；重试后仍失败：${secondAttempt.error.message}`,
      firstContent,
      repairedContent
    );
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
        max_tokens: STREAM_MAX_TOKENS,
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

  const LOOKUP_CACHE_STORAGE_KEY = 'mingchao.lookupTerm.cache.v1';
  const LOOKUP_CACHE_MAX_ENTRIES = 500;
  const LOOKUP_CACHE_EVICT_BATCH = 100;

  const lookupMemoryCache = new Map();
  const lookupInflight = new Map();
  let lookupCacheHydrated = false;

  function normalizeLookupKey(term) {
    return (term || '')
      .trim()
      .replace(/\s+/g, '')
      .replace(/[“”"'《》〈〉（）()，。！？；：、]/g, '')
      .toLowerCase();
  }

  function hydrateLookupCache() {
    if (lookupCacheHydrated) return;
    lookupCacheHydrated = true;
    try {
      const raw = localStorage.getItem(LOOKUP_CACHE_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      const entries = parsed.entries;
      if (!Array.isArray(entries)) return;
      for (const item of entries) {
        if (!item || !item.key || !item.value) continue;
        lookupMemoryCache.set(item.key, item.value);
      }
    } catch (_) {
      try { localStorage.removeItem(LOOKUP_CACHE_STORAGE_KEY); } catch (__) {}
    }
  }

  function persistLookupCache() {
    try {
      const entries = [];
      for (const [key, value] of lookupMemoryCache) {
        entries.push({ key, value });
      }
      if (entries.length > LOOKUP_CACHE_MAX_ENTRIES) {
        const excess = entries.length - (LOOKUP_CACHE_MAX_ENTRIES - LOOKUP_CACHE_EVICT_BATCH);
        const trimmed = entries.slice(excess);
        lookupMemoryCache.clear();
        for (const item of trimmed) lookupMemoryCache.set(item.key, item.value);
        localStorage.setItem(LOOKUP_CACHE_STORAGE_KEY, JSON.stringify({ entries: trimmed }));
        return;
      }
      localStorage.setItem(LOOKUP_CACHE_STORAGE_KEY, JSON.stringify({ entries }));
    } catch (_) { /* storage 满或隐身模式，忽略 */ }
  }

  function readLookupCache(key) {
    hydrateLookupCache();
    if (!lookupMemoryCache.has(key)) return null;
    const value = lookupMemoryCache.get(key);
    lookupMemoryCache.delete(key);
    lookupMemoryCache.set(key, value);
    return value;
  }

  function writeLookupCache(key, value) {
    lookupMemoryCache.set(key, value);
    persistLookupCache();
  }

  function isLookupGenericTerm(term) {
    const clean = (term || '').trim();
    if (!clean) return true;
    if (clean.length <= 1) return true;
    return /^(百姓|军民|军队|士兵|将士|局势|事情|消息|时候|城中|城外|家人|众人|大家|我们|你们|他们|自己|前方|后方|东西)$/.test(clean);
  }

  async function lookupTerm(term, context = '') {
    const cleanTerm = (term || '').trim();
    if (!cleanTerm) throw new Error('查询词为空');
    if (isLookupGenericTerm(cleanTerm)) {
      return { term: cleanTerm, category: 'other', intro: '', fromCache: false };
    }

    const cacheKey = normalizeLookupKey(cleanTerm);
    if (cacheKey) {
      const cached = readLookupCache(cacheKey);
      if (cached) return { ...cached, fromCache: true };

      if (lookupInflight.has(cacheKey)) {
        const shared = await lookupInflight.get(cacheKey);
        return { ...shared, fromCache: true };
      }
    }

    const systemPrompt = '你是一位严谨的明史与中国古代史专家。用户选中了一段文字，请判断其类别并给出名词解释。必须返回严格 JSON，禁止输出任何 markdown、代码块、前缀说明。所有字符串必须正确闭合，所有属性名必须使用双引号。';
    const contextLine = context ? `\n该词所处的场景上下文：「${context}」` : '';
    const userPrompt = `请为以下选中文本生成名词解释：「${cleanTerm}」${contextLine}

要求：
1. 必须返回如下结构的严格 JSON：
{
  "term": "${cleanTerm}",
  "category": "person/place/work/herb/weapon/era/office/institution/event/other",
  "intro": "中文介绍"
}
2. category 必须从以上 10 个枚举值中选择一个：人物=person，地名=place，著作名称=work，药材=herb，兵器/器物=weapon，年号=era，官职=office，机构=institution，事件=event，其他=other
3. intro 字数按 category 分档：person 类 180 到 260 字；place/era/office/institution 类 120 到 180 字；work/herb/weapon/event/other 类 100 到 160 字
4. intro 必须使用第三人称客观语气，禁止使用现代词汇
5. 如果该选中文本并非一个可解释的专有名词（如只是一个普通短语、形容词、代词），category 必须为 other，intro 必须返回空字符串`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const fetchPromise = (async () => {
      const raw = await requestJson(messages, 0.3);
      const attempt = tryParseWithRepair(raw);
      if (!attempt.ok) {
        throw buildParseError(`名词查询解析失败：${attempt.error.message}`, raw);
      }
      const result = attempt.value || {};
      return {
        term: (result.term || cleanTerm).toString(),
        category: (result.category || 'other').toString(),
        intro: (result.intro || '').toString()
      };
    })();

    if (cacheKey) lookupInflight.set(cacheKey, fetchPromise);

    try {
      const resolved = await fetchPromise;
      if (cacheKey && resolved.intro) writeLookupCache(cacheKey, resolved);
      return { ...resolved, fromCache: false };
    } finally {
      if (cacheKey) lookupInflight.delete(cacheKey);
    }
  }

  function clearLookupCache() {
    lookupMemoryCache.clear();
    lookupInflight.clear();
    try { localStorage.removeItem(LOOKUP_CACHE_STORAGE_KEY); } catch (_) {}
  }

  return { chat, chatStream, lookupTerm, clearLookupCache, API_KEY };
})();
