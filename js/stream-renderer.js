/**
 * StreamRenderer — 流式打字机渲染器
 */
const StreamRenderer = (() => {

  // 打字机效果：逐字符渲染
  function typewrite(el, text, speed = 30) {
    return new Promise(resolve => {
      el.textContent = '';
      let i = 0;
      function next() {
        if (i < text.length) {
          el.textContent += text[i++];
          el.scrollIntoView({ block: 'end', behavior: 'smooth' });
          setTimeout(next, speed);
        } else {
          resolve();
        }
      }
      next();
    });
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
  async function renderScene(sceneData, containers) {
    const { sceneEl, npcEl, questionEl, optionsEl, noteEl } = containers;

    // 清空旧内容
    optionsEl.innerHTML = '';
    optionsEl.style.display = 'none';
    if (npcEl) npcEl.style.display = 'none';
    if (noteEl) noteEl.style.display = 'none';

    // 打字机输出场景描述
    sceneEl.textContent = '';
    await typewrite(sceneEl, sceneData.scene, 28);

    // NPC 对话
    if (sceneData.npc_dialogue && npcEl) {
      npcEl.style.display = 'flex';
      const nameEl = npcEl.querySelector('.npc-name');
      const textEl = npcEl.querySelector('.npc-text');
      if (nameEl) nameEl.textContent = sceneData.npc_name || '';
      if (textEl) await typewrite(textEl, `"${sceneData.npc_dialogue}"`, 32);
    }

    // 问题
    if (questionEl) {
      await typewrite(questionEl, sceneData.question, 35);
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
      btn.className = 'option-btn';
      btn.dataset.id = opt.id;
      btn.dataset.text = opt.text;
      btn.dataset.reputationDelta = opt.reputation_delta;
      btn.dataset.riskDelta = opt.risk_delta;
      btn.dataset.insightDelta = opt.insight_delta;
      btn.dataset.reputationReason = opt.score_reason?.reputation || '';
      btn.dataset.riskReason = opt.score_reason?.risk || '';
      btn.dataset.insightReason = opt.score_reason?.insight || '';
      btn.innerHTML = `<span class="opt-label">${opt.id}</span><span class="opt-text">${opt.text}</span>`;
      btn.style.animationDelay = `${idx * 100}ms`;
      optionsEl.appendChild(btn);
    });

    // 显示历史注释按钮
    if (sceneData.historical_note && noteEl) {
      const toggleBtn = document.getElementById('note-toggle');
      if (toggleBtn) toggleBtn.style.display = 'flex';
    }
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

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  return { typewrite, appendChar, renderScene, renderConsequence, delay };
})();
