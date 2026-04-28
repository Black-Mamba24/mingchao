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

  const ANNOTATION_SCORE_WEIGHTS = {
    decision_relevance: 0.22,
    context_impact: 0.18,
    historical_specificity: 0.14,
    archaicness: 0.12,
    modern_unfamiliarity: 0.10,
    ambiguity: 0.08,
    specificity: 0.08,
    information_gain: 0.08
  };

  const GENERIC_TERMS = new Set([
    '皇帝', '朝廷', '官兵', '将军', '大臣', '宫中', '天下', '京城', '军队', '兵马', '百姓', '叛军', '敌军', '官府', '圣旨', '懿旨', '监国', '即位'
  ]);

  const GENERIC_SUFFIXES = ['之战', '局势', '朝廷', '官府', '兵马', '军士'];

  function clampScore(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(1, num));
  }

  function normalizeCandidate(annotation = {}) {
    const key = (annotation?.key || annotation?.term || '').trim();
    const term = (annotation?.term || '').trim();
    const intro = (annotation?.intro || '').trim();
    const category = (annotation?.category || 'other').trim() || 'other';
    const scores = Object.keys(ANNOTATION_SCORE_WEIGHTS).reduce((acc, field) => {
      acc[field] = clampScore(annotation?.scores?.[field]);
      return acc;
    }, {});
    return { key, term, intro, category, scores };
  }

  function computeAnnotationScore(annotation) {
    return Object.entries(ANNOTATION_SCORE_WEIGHTS).reduce((total, [field, weight]) => {
      return total + clampScore(annotation?.scores?.[field]) * weight;
    }, 0);
  }

  function isLikelyGenericTerm(term) {
    const normalized = normalizeTermKey(term);
    if (!normalized) return true;
    if (GENERIC_TERMS.has(term.trim())) return true;
    return GENERIC_SUFFIXES.some(suffix => term.endsWith(suffix) && term.length <= suffix.length + 2);
  }

  function isValidAnnotation(annotation, text) {
    if (!annotation.key || !annotation.term || !annotation.intro || annotation.intro.length > 300) return false;
    return (text || '').includes(annotation.term);
  }

  function resolveOverlap(candidates) {
    const accepted = [];
    const sorted = [...candidates].sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      if (b.term.length !== a.term.length) return b.term.length - a.term.length;
      return b.totalScore - a.totalScore;
    });

    sorted.forEach(candidate => {
      const conflictIndex = accepted.findIndex(item => !(candidate.end <= item.start || candidate.start >= item.end));
      if (conflictIndex === -1) {
        accepted.push(candidate);
        return;
      }
      const current = accepted[conflictIndex];
      const shouldReplace =
        candidate.totalScore > current.totalScore ||
        (candidate.totalScore === current.totalScore && candidate.term.length > current.term.length);
      if (shouldReplace) accepted[conflictIndex] = candidate;
    });

    return accepted.sort((a, b) => a.start - b.start || b.term.length - a.term.length);
  }

  function resolveAnnotationsForText(text, rawItems = [], introducedTerms = [], introducedAliases = {}) {
    const sourceText = text || '';
    const aliasMap = Object.entries(introducedAliases || {}).reduce((acc, [term, key]) => {
      const normalizedTerm = normalizeTermKey(term);
      const normalizedKey = normalizeTermKey(key);
      if (normalizedTerm && normalizedKey) acc[normalizedTerm] = normalizedKey;
      return acc;
    }, {});
    const introducedKeySet = new Set((introducedTerms || []).map(normalizeTermKey).filter(Boolean));
    const seenKeys = new Set();
    const seenTerms = new Set();

    const prepared = normalizeAnnotations(rawItems)
      .map(normalizeCandidate)
      .filter(item => isValidAnnotation(item, sourceText))
      .map(item => {
        const normalizedKey = normalizeTermKey(item.key || item.term);
        const normalizedTerm = normalizeTermKey(item.term);
        const introducedAliasKey = aliasMap[normalizedTerm];
        const start = sourceText.indexOf(item.term);
        return {
          ...item,
          key: normalizedKey,
          normalizedTerm,
          start,
          end: start === -1 ? -1 : start + item.term.length,
          totalScore: computeAnnotationScore(item),
          wasIntroduced: introducedKeySet.has(normalizedKey) || introducedAliasKey === normalizedKey || !!introducedAliasKey,
          isGeneric: isLikelyGenericTerm(item.term)
        };
      })
      .filter(item => item.start !== -1)
      .filter(item => !item.isGeneric || item.totalScore >= 0.55)
      .map(item => ({
        ...item,
        totalScore: item.totalScore - (item.wasIntroduced ? 0.35 : 0)
      }))
      .filter(item => item.totalScore > 0);

    const deduped = [];
    prepared
      .sort((a, b) => b.totalScore - a.totalScore || b.term.length - a.term.length || a.start - b.start)
      .forEach(item => {
        if (seenKeys.has(item.key) || seenTerms.has(item.normalizedTerm)) return;
        if (aliasMap[item.normalizedTerm] && aliasMap[item.normalizedTerm] === item.key) return;
        const coveredBySpecific = deduped.some(existing => {
          const overlaps = !(item.end <= existing.start || item.start >= existing.end);
          const sameRangeFamily = existing.term.includes(item.term) || item.term.includes(existing.term);
          return overlaps && sameRangeFamily && existing.totalScore >= item.totalScore;
        });
        if (coveredBySpecific) return;
        seenKeys.add(item.key);
        seenTerms.add(item.normalizedTerm);
        deduped.push(item);
      });

    return resolveOverlap(deduped)
      .sort((a, b) => b.totalScore - a.totalScore || b.term.length - a.term.length || a.start - b.start)
      .slice(0, 5)
      .sort((a, b) => a.start - b.start || b.term.length - a.term.length)
      .map(({ normalizedTerm, totalScore, start, end, wasIntroduced, isGeneric, scores, ...annotation }) => annotation);
  }

  function pickResolvedAnnotations(text, candidateItems = [], fallbackAnnotations = [], introducedTerms = [], introducedAliases = {}) {
    const resolvedFromCandidates = resolveAnnotationsForText(text, candidateItems, introducedTerms, introducedAliases);
    if (resolvedFromCandidates.length) return resolvedFromCandidates;
    return resolveAnnotationsForText(text, fallbackAnnotations, introducedTerms, introducedAliases);
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

    const getCurrentIntroduced = () => introducedTerms.concat(newlyIntroduced.map(item => item.key));

    // 打字机输出场景描述
    sceneEl.textContent = '';
    const sceneAnnotations = pickResolvedAnnotations(
      sceneData.scene,
      sceneData.scene_annotation_candidates,
      sceneData.scene_annotations,
      getCurrentIntroduced(),
      introducedAliases
    );
    const sceneKeys = await typewriteAnnotated(sceneEl, sceneData.scene, sceneAnnotations, getCurrentIntroduced(), introducedAliases, 28);
    newlyIntroduced.push(...sceneKeys);

    // NPC 对话
    if (sceneData.npc_dialogue && npcEl) {
      npcEl.style.display = 'flex';
      const nameEl = npcEl.querySelector('.npc-name');
      const textEl = npcEl.querySelector('.npc-text');
      if (nameEl) nameEl.textContent = sceneData.npc_name || '';
      if (textEl) {
        const npcAnnotations = pickResolvedAnnotations(
          sceneData.npc_dialogue,
          sceneData.npc_annotation_candidates,
          sceneData.npc_annotations,
          getCurrentIntroduced(),
          introducedAliases
        );
        const npcKeys = await typewriteAnnotated(textEl, `"${sceneData.npc_dialogue}"`, npcAnnotations, getCurrentIntroduced(), introducedAliases, 32);
        newlyIntroduced.push(...npcKeys);
      }
    }

    // 问题
    if (questionEl) {
      const questionAnnotations = pickResolvedAnnotations(
        sceneData.question,
        sceneData.question_annotation_candidates,
        sceneData.question_annotations,
        getCurrentIntroduced(),
        introducedAliases
      );
      const questionKeys = await typewriteAnnotated(questionEl, sceneData.question, questionAnnotations, getCurrentIntroduced(), introducedAliases, 35);
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

  async function renderAnnotatedConsequence(el, text, annotations = [], introducedTerms = [], introducedAliases = {}, candidateItems = []) {
    el.innerHTML = '<div class="consequence-title">局势余波</div><div class="consequence-body"></div>';
    el.classList.add('visible');
    const bodyEl = el.querySelector('.consequence-body');
    const resolvedAnnotations = pickResolvedAnnotations(text, candidateItems, annotations, introducedTerms, introducedAliases);
    const introducedKeys = await typewriteAnnotated(bodyEl, text, resolvedAnnotations, introducedTerms, introducedAliases, 26);
    return introducedKeys;
  }

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  return { typewrite, typewriteAnnotated, renderAnnotatedText, appendChar, renderScene, renderConsequence, renderAnnotatedConsequence, delay };
})();
