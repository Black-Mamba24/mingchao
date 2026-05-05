/**
 * SelectionLookup — 文本选中后提供「放大镜」按需查询名词解释
 *
 * 设计原则（第一性原理）：
 * 1. 只响应正文容器 (#scene-wrap) 内的选区，避免干扰 UI 文字
 * 2. 选中长度必须 >= 2 且 < 20（< 2 为误触，>= 20 视为整段文字）
 * 3. 选中内容不能已经命中 .term-annotation（避免与既有机制冲突）
 * 4. 放大镜为 fixed 定位，跟随选区 bottom-right 浮动
 * 5. 查询结果复用 #term-popover 的视觉样式，与既有解释一致
 */
const SelectionLookup = (() => {

  const MIN_LEN = 2;
  const MAX_LEN = 20;
  const DEBUG = typeof window !== 'undefined' && window.__SELECTION_LOOKUP_DEBUG__ === true;

  function log(...args) {
    if (DEBUG) console.log('[SelectionLookup]', ...args);
  }

  const CATEGORY_LABELS = {
    person: '人物',
    place: '地名',
    work: '著作',
    herb: '药材',
    weapon: '武器',
    era: '年号',
    office: '职位',
    institution: '机构',
    event: '事件',
    other: '名词'
  };

  let rootContainer = null;
  let popoverEl = null;
  let titleEl = null;
  let categoryEl = null;
  let bodyEl = null;
  let iconEl = null;
  let pendingTerm = '';
  let pendingContext = '';
  let pendingAnchorRect = null;
  let inflightToken = 0;

  function init(options = {}) {
    rootContainer = options.container || document.getElementById('scene-wrap');
    popoverEl = document.getElementById('term-popover');
    titleEl = document.getElementById('term-popover-title');
    categoryEl = document.getElementById('term-popover-category');
    bodyEl = document.getElementById('term-popover-body');

    if (!rootContainer || !popoverEl || !titleEl || !categoryEl || !bodyEl) {
      console.warn('[SelectionLookup] 初始化失败，缺少必要 DOM', {
        rootContainer: !!rootContainer,
        popoverEl: !!popoverEl,
        titleEl: !!titleEl,
        categoryEl: !!categoryEl,
        bodyEl: !!bodyEl
      });
      return;
    }

    ensureIcon();
    bindEvents();
    log('init 完成，监听已挂载', { container: rootContainer.id || rootContainer });
  }

  function ensureIcon() {
    if (iconEl) return;
    iconEl = document.createElement('button');
    iconEl.type = 'button';
    iconEl.id = 'selection-lookup-icon';
    iconEl.className = 'selection-lookup-icon';
    iconEl.setAttribute('aria-label', '查询名词解释');
    iconEl.innerHTML = `
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
        <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/>
        <line x1="15.2" y1="15.2" x2="20" y2="20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
    `;
    iconEl.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    iconEl.addEventListener('click', handleIconClick);
    document.body.appendChild(iconEl);
  }

  function bindEvents() {
    document.addEventListener('mouseup', handleSelectionChange, true);
    document.addEventListener('touchend', handleSelectionChange, true);
    document.addEventListener('keyup', e => {
      if (e.key === 'Shift' || e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
          e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'End' || e.key === 'Home') {
        handleSelectionChange();
      }
    });
    document.addEventListener('mousedown', e => {
      if (iconEl && iconEl.contains(e.target)) return;
      if (popoverEl && popoverEl.contains(e.target)) return;
      hideIcon();
    }, true);
    window.addEventListener('scroll', hideIcon, true);
    window.addEventListener('resize', hideIcon);
  }

  function handleSelectionChange() {
    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        log('选区为空或未建立', {
          selection: !!selection,
          rangeCount: selection ? selection.rangeCount : 0,
          collapsed: selection ? selection.isCollapsed : null
        });
        hideIcon();
        return;
      }

      const rawText = selection.toString();
      const text = rawText.trim();
      if (text.length < MIN_LEN) {
        log('选区长度过短，忽略', { length: text.length, text });
        hideIcon();
        return;
      }
      if (text.length >= MAX_LEN) {
        log('选区长度超限，忽略', { length: text.length });
        hideIcon();
        return;
      }

      const range = selection.getRangeAt(0);
      if (!isRangeInsideRoot(range)) {
        log('选区不在 scene-wrap 内，忽略', { container: rootContainer && rootContainer.id });
        hideIcon();
        return;
      }

      if (isRangeFullyInsideAnnotation(range)) {
        log('选区完全落在已有 .term-annotation 内，忽略');
        hideIcon();
        return;
      }

      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        log('选区矩形为空，忽略');
        hideIcon();
        return;
      }

      pendingTerm = text;
      pendingContext = extractContext(range);
      pendingAnchorRect = rect;
      log('✅ 展示放大镜', { text, rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } });
      showIconAt(rect);
    }, 10);
  }

  function isRangeInsideRoot(range) {
    if (!rootContainer) return false;
    const common = range.commonAncestorContainer;
    const node = common.nodeType === 1 ? common : common.parentNode;
    if (!node) return false;
    return rootContainer === node || rootContainer.contains(node);
  }

  function isRangeFullyInsideAnnotation(range) {
    const startNode = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentNode;
    const endNode = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentNode;
    if (!startNode || !endNode) return false;
    const startAnn = startNode.closest && startNode.closest('.term-annotation');
    const endAnn = endNode.closest && endNode.closest('.term-annotation');
    return !!(startAnn && endAnn && startAnn === endAnn);
  }

  function extractContext(range) {
    const common = range.commonAncestorContainer;
    const hostEl = common.nodeType === 1 ? common : common.parentNode;
    const paragraphEl = hostEl && hostEl.closest ? (hostEl.closest('p, li, blockquote, div') || hostEl) : hostEl;
    const raw = paragraphEl && paragraphEl.textContent ? paragraphEl.textContent.trim() : '';
    const sceneTextEl = document.getElementById('scene-text');
    const npcTextEl = document.getElementById('npc-text');
    const questionTextEl = document.getElementById('question-text');
    const roleLabelEl = document.getElementById('role-label');
    const contextParts = [];

    if (roleLabelEl && roleLabelEl.textContent.trim()) {
      contextParts.push(`当前角色：${roleLabelEl.textContent.trim()}`);
    }
    if (raw) {
      contextParts.push(`当前段落：${raw.length > 160 ? `${raw.slice(0, 160)}…` : raw}`);
    }
    if (sceneTextEl && sceneTextEl.textContent.trim()) {
      contextParts.push(`场景：${sceneTextEl.textContent.trim().slice(0, 180)}`);
    }
    if (npcTextEl && npcTextEl.textContent.trim()) {
      contextParts.push(`NPC：${npcTextEl.textContent.trim().slice(0, 80)}`);
    }
    if (questionTextEl && questionTextEl.textContent.trim()) {
      contextParts.push(`抉择：${questionTextEl.textContent.trim().slice(0, 80)}`);
    }

    return contextParts.join('；').slice(0, 420);
  }

  function showIconAt(rect) {
    if (!iconEl) return;
    const iconSize = 28;
    const padding = 6;
    let left = rect.right + padding;
    let top = rect.top - iconSize - padding;

    if (left + iconSize > window.innerWidth - 8) {
      left = Math.max(8, rect.left - iconSize - padding);
    }
    if (top < 8) {
      top = rect.bottom + padding;
    }
    if (top + iconSize > window.innerHeight - 8) {
      top = window.innerHeight - iconSize - 8;
    }

    iconEl.style.left = `${left}px`;
    iconEl.style.top = `${top}px`;
    iconEl.classList.add('visible');
    iconEl.classList.remove('loading');
    iconEl.disabled = false;
  }

  function hideIcon() {
    if (!iconEl) return;
    iconEl.classList.remove('visible');
    iconEl.classList.remove('loading');
    iconEl.disabled = false;
  }

  async function handleIconClick(event) {
    event.preventDefault();
    event.stopPropagation();

    if (!pendingTerm || !pendingAnchorRect) return;
    if (typeof LLMClient === 'undefined' || typeof LLMClient.lookupTerm !== 'function') {
      showPopoverError(pendingAnchorRect, pendingTerm, '名词查询服务未就绪');
      return;
    }

    const term = pendingTerm;
    const context = pendingContext;
    const anchorRect = pendingAnchorRect;
    const token = ++inflightToken;

    let loadingTimer = setTimeout(() => {
      if (token !== inflightToken) return;
      iconEl.classList.add('loading');
      iconEl.disabled = true;
      showPopoverLoading(anchorRect, term);
      loadingTimer = null;
    }, 80);

    try {
      const result = await LLMClient.lookupTerm(term, context);
      if (token !== inflightToken) return;
      if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
      showPopoverResult(anchorRect, result);
    } catch (err) {
      if (token !== inflightToken) return;
      if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
      const msg = err && err.message ? err.message : '查询失败，请稍后再试';
      showPopoverError(anchorRect, term, msg);
    } finally {
      if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
      if (token === inflightToken) {
        iconEl.classList.remove('loading');
        iconEl.disabled = false;
      }
    }
  }

  function showPopoverLoading(rect, term) {
    if (!popoverEl) return;
    titleEl.textContent = term;
    categoryEl.textContent = '查询中…';
    bodyEl.textContent = '正在向 DeepSeek 查询该词的历史含义，请稍候。';
    presentPopover(rect);
  }

  function showPopoverResult(rect, result) {
    if (!popoverEl) return;
    titleEl.textContent = result.term || '';
    categoryEl.textContent = CATEGORY_LABELS[result.category] || CATEGORY_LABELS.other;
    bodyEl.textContent = result.intro || '';
    presentPopover(rect);
  }

  function showPopoverError(rect, term, message) {
    if (!popoverEl) return;
    titleEl.textContent = term;
    categoryEl.textContent = '查询失败';
    bodyEl.textContent = message;
    presentPopover(rect);
  }

  function presentPopover(rect) {
    const maxWidth = Math.min(320, window.innerWidth - 24);
    popoverEl.style.width = `${maxWidth}px`;
    popoverEl.classList.add('visible');

    const popRect = popoverEl.getBoundingClientRect();
    let left = rect.left;
    let top = rect.bottom + 10;
    if (left + popRect.width > window.innerWidth - 12) left = window.innerWidth - popRect.width - 12;
    if (left < 12) left = 12;
    if (top + popRect.height > window.innerHeight - 12) top = rect.top - popRect.height - 10;
    if (top < 12) top = 12;
    popoverEl.style.left = `${left}px`;
    popoverEl.style.top = `${top}px`;
  }

  return { init };
})();

window.SelectionLookup = SelectionLookup;
