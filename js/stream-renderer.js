/**
 * StreamRenderer — 流式打字机渲染器
 */
const StreamRenderer = (() => {

  function normalizeTermKey(value) {
    return (value || '').trim().replace(/[“”"'《》〈〉（）()，。！？；：、\s]/g, '').toLowerCase();
  }

  function normalizeAnnotations(annotations) {
    return Array.isArray(annotations) ? annotations : [];
  }

  function buildSegments(text, annotations = [], introducedTerms = [], introducedAliases = {}) {
    const sourceText = text || '';
    const seenTerms = new Set(introducedTerms.map(normalizeTermKey).filter(Boolean));
    const aliasMap = Object.entries(introducedAliases || {}).reduce((acc, [term, key]) => {
      const normalizedTerm = normalizeTermKey(term);
      const normalizedKey = normalizeTermKey(key);
      if (normalizedTerm && normalizedKey) acc[normalizedTerm] = normalizedKey;
      return acc;
    }, {});
    const seenKeysInBlock = new Set();
    const matches = [];

    normalizeAnnotations(annotations).forEach(annotation => {
      const term = (annotation?.term || '').trim();
      const intro = (annotation?.intro || '').trim();
      const normalizedTerm = normalizeTermKey(term);
      const key = normalizeTermKey(annotation?.key || term);
      const aliasKey = aliasMap[normalizedTerm];
      if (!term || !intro || intro.length > 300 || !key || seenTerms.has(key) || aliasKey || seenKeysInBlock.has(key) || seenKeysInBlock.has(normalizedTerm)) return;
      const start = sourceText.indexOf(term);
      if (start === -1) return;
      matches.push({
        start,
        end: start + term.length,
        key,
        term,
        intro,
        category: (annotation?.category || 'other').trim() || 'other'
      });
      seenKeysInBlock.add(key);
      seenKeysInBlock.add(normalizedTerm);
    });

    matches.sort((a, b) => a.start - b.start || b.term.length - a.term.length);

    const accepted = [];
    let lastEnd = -1;
    for (const match of matches) {
      if (match.start < lastEnd) continue;
      accepted.push(match);
      lastEnd = match.end;
    }

    const segments = [];
    let cursor = 0;
    accepted.forEach(match => {
      if (match.start > cursor) {
        segments.push({ type: 'text', text: sourceText.slice(cursor, match.start) });
      }
      segments.push({ type: 'annotation', text: match.term, annotation: match });
      cursor = match.end;
    });
    if (cursor < sourceText.length) {
      segments.push({ type: 'text', text: sourceText.slice(cursor) });
    }

    return {
      segments,
      introducedKeys: accepted.map(item => ({ key: item.key, term: item.term }))
    };
  }

  function createAnnotationNode(annotation) {
    const span = document.createElement('span');
    span.className = 'term-annotation';
    span.dataset.term = annotation.term;
    span.dataset.key = annotation.key;
    span.dataset.category = annotation.category;
    span.dataset.intro = annotation.intro;
    span.tabIndex = 0;
    return span;
  }

  function typewrite(el, text, speed = 30) {
    return typewriteAnnotated(el, text, [], [], speed);
  }

  function typewriteAnnotated(el, text, annotations = [], introducedTerms = [], introducedAliases = {}, speed = 30) {
    return new Promise(resolve => {
      el.textContent = '';
      const { segments, introducedKeys } = buildSegments(text, annotations, introducedTerms, introducedAliases);
      let segmentIndex = 0;
      let charIndex = 0;
      let currentNode = null;

      function next() {
        const segment = segments[segmentIndex];
        if (!segment) {
          resolve(introducedKeys);
          return;
        }

        if (!currentNode) {
          currentNode = segment.type === 'annotation'
            ? createAnnotationNode(segment.annotation)
            : document.createTextNode('');
          el.appendChild(currentNode);
        }

        if (charIndex < segment.text.length) {
          const char = segment.text[charIndex++];
          if (segment.type === 'annotation') {
            currentNode.textContent += char;
          } else {
            currentNode.textContent += char;
          }
          el.scrollIntoView({ block: 'end', behavior: 'smooth' });
          setTimeout(next, speed);
          return;
        }

        segmentIndex += 1;
        charIndex = 0;
        currentNode = null;
        next();
      }

      next();
    });
  }

  function renderAnnotatedText(el, text, annotations = [], introducedTerms = [], introducedAliases = {}) {
    el.textContent = '';
    const { segments, introducedKeys } = buildSegments(text, annotations, introducedTerms, introducedAliases);
    segments.forEach(segment => {
      if (segment.type === 'annotation') {
        const node = createAnnotationNode(segment.annotation);
        node.textContent = segment.text;
        el.appendChild(node);
        return;
      }
      el.appendChild(document.createTextNode(segment.text));
    });
    return introducedKeys;
  }

  // 追加单个字符（用于真正流式输出）
  let scrollTimer = null;
  function appendChar(el, char) {
    el.textContent += char;
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
    }, 32);
  }

  // 渲染场景数据到页面
  async function renderScene(sceneData, containers, introducedTerms = [], introducedAliases = {}) {
    const { sceneEl, npcEl, questionEl, optionsEl, noteEl } = containers;
    const newlyIntroduced = [];

    // 清空旧内容
    optionsEl.innerHTML = '';
    optionsEl.style.display = 'none';
    if (npcEl) npcEl.style.display = 'none';
    if (noteEl) noteEl.style.display = 'none';

    // 打字机输出场景描述
    sceneEl.textContent = '';
    const sceneKeys = await typewriteAnnotated(sceneEl, sceneData.scene, sceneData.scene_annotations, introducedTerms.concat(newlyIntroduced.map(item => item.key)), introducedAliases, 28);
    newlyIntroduced.push(...sceneKeys);

    // NPC 对话
    if (sceneData.npc_dialogue && npcEl) {
      npcEl.style.display = 'flex';
      const nameEl = npcEl.querySelector('.npc-name');
      const textEl = npcEl.querySelector('.npc-text');
      if (nameEl) nameEl.textContent = sceneData.npc_name || '';
      if (textEl) {
        const npcKeys = await typewriteAnnotated(textEl, `"${sceneData.npc_dialogue}"`, sceneData.npc_annotations, introducedTerms.concat(newlyIntroduced.map(item => item.key)), introducedAliases, 32);
        newlyIntroduced.push(...npcKeys);
      }
    }

    // 问题
    if (questionEl) {
      const questionKeys = await typewriteAnnotated(questionEl, sceneData.question, sceneData.question_annotations, introducedTerms.concat(newlyIntroduced.map(item => item.key)), introducedAliases, 35);
      newlyIntroduced.push(...questionKeys);
    }

    // 历史注释
    if (sceneData.historical_note && noteEl) {
      const noteText = noteEl.querySelector('.note-text');
      if (noteText) noteText.textContent = sceneData.historical_note;
    }

    // 渲染选项（带入场动画）
    await delay(300);
    optionsEl.style.display = 'grid';
    sceneData.options.forEach((opt, idx) => {
      const btn = document.createElement('button');
      const label = document.createElement('span');
      const text = document.createElement('span');
      btn.className = 'option-btn';
      btn.dataset.id = opt.id;
      btn.dataset.text = opt.text;
      btn.dataset.reputationDelta = opt.reputation_delta;
      btn.dataset.riskDelta = opt.risk_delta;
      btn.dataset.insightDelta = opt.insight_delta;
      btn.dataset.reputationReason = opt.score_reason?.reputation || '';
      btn.dataset.riskReason = opt.score_reason?.risk || '';
      btn.dataset.insightReason = opt.score_reason?.insight || '';
      label.className = 'opt-label';
      label.textContent = opt.id;
      text.className = 'opt-text';
      text.textContent = opt.text;
      btn.appendChild(label);
      btn.appendChild(text);
      btn.style.animationDelay = `${idx * 100}ms`;
      optionsEl.appendChild(btn);
    });

    // 显示历史注释按钮
    if (sceneData.historical_note && noteEl) {
      const toggleBtn = document.getElementById('note-toggle');
      if (toggleBtn) toggleBtn.style.display = 'flex';
    }

    return newlyIntroduced;
  }

  // 渲染后果文本（流式追加模式）
  function renderConsequence(el, onStart) {
    el.innerHTML = '<div class="consequence-title">局势余波</div><div class="consequence-body"></div>';
    el.classList.add('visible');
    const bodyEl = el.querySelector('.consequence-body');
    if (onStart) onStart();
    return {
      onChunk: (char) => appendChar(bodyEl, char),
      onDone: () => {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
      }
    };
  }

  async function renderAnnotatedConsequence(el, text, annotations = [], introducedTerms = [], introducedAliases = {}) {
    el.innerHTML = '<div class="consequence-title">局势余波</div><div class="consequence-body"></div>';
    el.classList.add('visible');
    const bodyEl = el.querySelector('.consequence-body');
    const introducedKeys = await typewriteAnnotated(bodyEl, text, annotations, introducedTerms, introducedAliases, 26);
    return introducedKeys;
  }

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  return { typewrite, typewriteAnnotated, renderAnnotatedText, appendChar, renderScene, renderConsequence, renderAnnotatedConsequence, delay };
})();
