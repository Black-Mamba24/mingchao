/**
 * StateManager — 玩家状态管理
 * 管理声望、风险、历史洞察值，持久化到 localStorage
 */
const StateManager = (() => {
  const KEY = 'mingchao_state';

  const defaultState = () => ({
    eventId: null,
    roleId: null,
    act: 1,
    scene: 0,
    reputation: 5,
    risk: 0,
    insight: 0,
    history: [],            // 对话历史，用于上下文
    choices: [],            // 玩家每次选择记录
    lastSceneContext: null, // 上一场景的承接信息 {sceneText, chosenOption, consequenceText}
    lastScoreChange: null,
    introducedTerms: [],
    introducedTermAliases: {},
    finished: false
  });

  let state = defaultState();

  function load() {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) state = { ...defaultState(), ...JSON.parse(saved) };
    } catch (e) { state = defaultState(); }
    return state;
  }

  function save() {
    localStorage.setItem(KEY, JSON.stringify(state));
  }

  function reset() {
    state = defaultState();
    localStorage.removeItem(KEY);
  }

  function get(key) {
    return key ? state[key] : { ...state };
  }

  function set(key, value) {
    state[key] = value;
    save();
  }

  function applyDeltas(deltas = {}) {
    if (deltas.reputation_delta) {
      state.reputation = Math.max(0, Math.min(10, state.reputation + deltas.reputation_delta));
    }
    if (deltas.risk_delta) {
      state.risk = Math.max(0, Math.min(10, state.risk + deltas.risk_delta));
    }
    if (deltas.insight_delta) {
      state.insight = Math.max(0, Math.min(10, state.insight + deltas.insight_delta));
    }
    save();
  }

  function pushHistory(role, content) {
    state.history.push({ role, content });
    // 滑动窗口：最多保留最近10条
    if (state.history.length > 10) state.history = state.history.slice(-10);
    save();
  }

  function recordChoice(act, scene, optionId, optionText) {
    state.choices.push({ act, scene, optionId, optionText });
    save();
  }

  function setLastSceneContext(sceneText, chosenOption, consequenceText) {
    state.lastSceneContext = { sceneText, chosenOption, consequenceText };
    save();
  }

  function setLastScoreChange(scoreChange) {
    state.lastScoreChange = scoreChange;
    save();
  }

  function normalizeIntroducedTerm(key) {
    return (key || '').trim().replace(/[“”"'《》〈〉（）()，。！？；：、\s]/g, '').toLowerCase();
  }

  function getIntroducedTerms() {
    return Array.isArray(state.introducedTerms) ? [...state.introducedTerms] : [];
  }

  function getIntroducedTermAliases() {
    const aliases = state.introducedTermAliases;
    return aliases && typeof aliases === 'object' ? { ...aliases } : {};
  }

  function hasIntroducedTerm(key, term = '') {
    const normalizedKey = normalizeIntroducedTerm(key);
    const normalizedTerm = normalizeIntroducedTerm(term);
    const introduced = getIntroducedTerms();
    const aliases = getIntroducedTermAliases();
    return introduced.includes(normalizedKey) || (normalizedTerm && aliases[normalizedTerm]);
  }

  function markIntroducedTerms(entries = []) {
    const mergedTerms = new Set(getIntroducedTerms());
    const aliases = getIntroducedTermAliases();
    let changed = false;

    entries.forEach(entry => {
      const rawKey = typeof entry === 'string' ? entry : entry?.key;
      const rawTerm = typeof entry === 'string' ? '' : entry?.term;
      const normalizedKey = normalizeIntroducedTerm(rawKey || rawTerm);
      const normalizedTerm = normalizeIntroducedTerm(rawTerm || rawKey);
      if (!normalizedKey) return;
      if (!mergedTerms.has(normalizedKey)) {
        mergedTerms.add(normalizedKey);
        changed = true;
      }
      if (normalizedTerm && aliases[normalizedTerm] !== normalizedKey) {
        aliases[normalizedTerm] = normalizedKey;
        changed = true;
      }
    });

    if (!changed) return;
    state.introducedTerms = Array.from(mergedTerms);
    state.introducedTermAliases = aliases;
    save();
  }

  function getProgressMeta() {
    const totalActs = 4;
    const scenesPerAct = 3;
    const totalScenes = totalActs * scenesPerAct;
    const currentSceneNumber = Math.min(totalScenes, (state.act - 1) * scenesPerAct + state.scene + 1);
    return {
      totalActs,
      scenesPerAct,
      totalScenes,
      currentAct: state.act,
      currentScene: state.scene + 1,
      currentSceneNumber,
      finished: !!state.finished
    };
  }

  function nextScene(actData) {
    state.scene += 1;
    // 每幕3个scene后进入下一幕
    if (state.scene >= 3 && state.act < 4) {
      state.act += 1;
      state.scene = 0;
    } else if (state.scene >= 3 && state.act === 4) {
      state.finished = true;
    }
    save();
  }

  return { load, save, reset, get, set, applyDeltas, pushHistory, recordChoice, setLastSceneContext, setLastScoreChange, getIntroducedTerms, getIntroducedTermAliases, hasIntroducedTerm, markIntroducedTerms, getProgressMeta, nextScene };
})();
