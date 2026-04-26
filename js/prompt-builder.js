/**
 * PromptBuilder — 历史约束包构建器
 * 将历史数据库 + 玩家状态 + 对话历史组装成 LLM 请求
 */
const PromptBuilder = (() => {

  // 兼容 acts 为数组（旧格式）或以 roleId 为 key 的对象（新格式）
  function resolveActs(eventData, roleId) {
    const acts = eventData.acts;
    if (Array.isArray(acts)) return acts;
    return (roleId && acts[roleId]) ? acts[roleId] : [];
  }

  function normalizeTermKey(value) {
    return (value || '').trim();
  }

  function buildTermAnnotationGuide(state) {
    const introducedTerms = Array.isArray(state.introducedTerms)
      ? state.introducedTerms.map(normalizeTermKey).filter(Boolean)
      : [];

    return `【名词解释输出要求】
- 你需要为当前 scene、npc_dialogue、question、consequence 中适合解释的历史专有名词生成结构化 annotations
- 可解释对象包括：历史人物、地名、古地名、古称、武器名、年号、职位、机构、事件，以及现代读者不常用但会影响理解的历史词语
- 每个文本块应尽可能覆盖最值得解释的词，最多标注 5 个，不要浪费名额
- 优先级从高到低：古称/古地名/古今名称差异大的词（如金陵、平江、江州）＞现代不常用的历史词（如舆图）＞关键历史人物与机构＞普通地名
- 若某地名今天仍广为人知、按字面即可理解（如芜湖），且当前文本里还有更值得解释的古称或历史词，优先不要选它
- 如果一段里同时有人名和关键古地名，不能只解释人名，需尽量补足关键地名
- term 必须与对应文本中的实际字面完全一致
- intro 必须是中文，信息准确，控制在300字以内，直接解释这个词在当前历史语境中的含义
- 同一文本块中，同一专有名词若出现多次，只返回一次 annotation
- 不要为 options 中的任何词生成解释
- 已经在本局介绍过的专有名词不要再次输出到 annotations：${introducedTerms.length ? introducedTerms.join('、') : '（暂无）'}`;
  }

  function buildScoreNarrativeGuide(state) {
    const guides = [];

    if (state.reputation >= 8) {
      guides.push('【声望态势】你的名声已高涨。当前场景中，至少一名NPC或机构必须明确表现出信任、倚重、让你承担更大责任，选项中可出现号召、说服、调度、统御型行动。');
    } else if (state.reputation <= 3) {
      guides.push('【声望态势】你的声望偏低。当前场景中，应体现被质疑、被掣肘、需要自证的局面，高杠杆号令型选项应减少。');
    } else {
      guides.push('【声望态势】你的声望处于中段。当前场景中，他人对你既有观察也有保留，支持通常附带条件。');
    }

    if (state.risk >= 8) {
      guides.push('【风险态势】你的风险极高。当前场景必须出现直接压力，如监视、追击、弹劾、怀疑、暴露、军令催逼等，选项中可出现掩护、撤退、转移视线或铤而走险。');
    } else if (state.risk <= 3) {
      guides.push('【风险态势】你暂未暴露于重大威胁，局势仍有回旋余地，但不可写得毫无紧张感。');
    } else {
      guides.push('【风险态势】风险正在积聚。当前场景要体现气氛收紧、后果逼近或有人开始留意你的举动。');
    }

    if (state.insight >= 8) {
      guides.push('【洞察态势】你的历史洞察极高。当前场景必须揭示至少一条更深层的动机、陷阱、权力关系或隐藏信息，选项中可出现识破、试探、设局、借势等高判断力行动。');
    } else if (state.insight <= 3) {
      guides.push('【洞察态势】你的判断有限。当前场景的信息应更模糊，容易出现误导或看不透的局面。');
    } else {
      guides.push('【洞察态势】你已具备一定判断力。当前场景可以让你察觉端倪，但不必一次看透全局。');
    }

    return guides.join('\n');
  }

  function buildLastScoreChangeGuide(state) {
    const lastChange = state.lastScoreChange;
    if (!lastChange) return '';

    const parts = [];
    if (lastChange.deltas.reputation) {
      parts.push(`声望${lastChange.deltas.reputation > 0 ? '+' : ''}${lastChange.deltas.reputation}（${lastChange.reasons.reputation || '由刚才的公开表现引发'}）`);
    }
    if (lastChange.deltas.risk) {
      parts.push(`风险${lastChange.deltas.risk > 0 ? '+' : ''}${lastChange.deltas.risk}（${lastChange.reasons.risk || '由刚才的局势暴露引发'}）`);
    }
    if (lastChange.deltas.insight) {
      parts.push(`历史洞察${lastChange.deltas.insight > 0 ? '+' : ''}${lastChange.deltas.insight}（${lastChange.reasons.insight || '由刚才的观察与判断引发'}）`);
    }

    if (!parts.length) {
      return '【最近一次分数变化】上一选择未引发显著数值波动，但人物关系与局势仍需延续。';
    }

    return `【最近一次分数变化】\n上一选择：${lastChange.optionText}\n变化结果：${parts.join('；')}\n当前场景必须承接这些变化，体现在人物态度、局势压力、信息开放程度或可选行动上。`;
  }

  function buildSystemPrompt(eventData, roleId) {
    const role = eventData.roles.find(r => r.id === roleId);
    const char = eventData.characters[roleId];
    const facts = eventData.historical_facts.join('\n- ');
    const constraints = eventData.constraints.join('\n- ');

    const isDirectorMode = roleId === 'zhu_yunwen';
    const directorNote = isDirectorMode
      ? `\n【导演模式说明】\n玩家扮演流亡的建文帝朱允炆，拥有「历史导演权」。在尊重地理常识与时代背景的前提下，允许适当发挥想象力，让玩家自行书写历史结局。场景可以充满奇思妙想，但不得出现现代科技或严重违背明代地理的内容。`
      : '';

    return `你是一个严谨的历史沉浸式叙事引擎，正在运行游戏《穿越明朝》。

【历史背景】
事件：${eventData.title}（${eventData.period}）
${eventData.description}

【玩家角色】
姓名：${char ? char.name : role.name}
身份：${role.subtitle}
视角：${role.perspective}
性格特征：${char ? char.personality : '朴实剽悍，忠勇耿直'}
说话风格：${char ? char.speech_style : '质朴直白'}
${directorNote}
【核心历史史实（必须遵守，不得篡改）】
- ${facts}

【生成约束（严格执行）】
- ${constraints}
- 不得改变任何历史大事件的结果
- 所有内容必须符合明代永乐至宣德年间的文化、礼制、语言习惯
- 禁止使用现代词汇和现代概念
- 每次生成必须返回严格的 JSON 格式，不得有任何前缀说明文字
- ${buildTermAnnotationGuide({ introducedTerms: [] }).replaceAll('\n', '\n- ').slice(0)}

【输出格式（严格JSON）】
${buildSceneOutputSchema()}

delta 取值范围：-2 到 +2，反映该选择对声望、风险、历史洞察的影响。

【分数变化说明要求】
- 每个选项都必须填写 score_reason
- 对于 delta 不为 0 的维度，必须解释“为什么会变”，每条解释控制在8到20字
- 解释要使用剧情内因果，不要写成“因为加了1点声望”这种元话术
- 若某维度 delta 为 0，可留空字符串
- 后续场景与选项设计必须参考玩家当前的声望、风险、历史洞察，不要只在旁白里提到数值，要真正改变人物态度、局势压力、信息开放程度和可行动作类型`;
  }

  function buildSceneOutputSchema() {
    return `{
  "scene": "场景描述，150-250字，第一人称沉浸式叙述，描写环境、情境、你当前面临的处境",
  "scene_annotations": [
    { "key": "专有名词唯一标识", "term": "scene中出现的词", "category": "person/place/weapon/era/office/institution/event/other", "intro": "不超过300字的中文介绍" }
  ],
  "npc_dialogue": "当前场景中重要NPC的一句话（如无NPC则为空字符串）",
  "npc_annotations": [
    { "key": "专有名词唯一标识", "term": "npc_dialogue中出现的词", "category": "person/place/weapon/era/office/institution/event/other", "intro": "不超过300字的中文介绍" }
  ],
  "npc_name": "说话的NPC姓名（如无则为空字符串）",
  "question": "当前你面临的核心抉择，用一个简洁的问句表达",
  "question_annotations": [
    { "key": "专有名词唯一标识", "term": "question中出现的词", "category": "person/place/weapon/era/office/institution/event/other", "intro": "不超过300字的中文介绍" }
  ],
  "annotation_strategy": "可选字段，简要说明本段为何选择这些词，优先覆盖古称、古地名和不常用历史词",
  "options": [
    { "id": "A", "text": "选项文字，不超过30字", "reputation_delta": 0, "risk_delta": 0, "insight_delta": 0, "score_reason": { "reputation": "", "risk": "", "insight": "" } },
    { "id": "B", "text": "选项文字，不超过30字", "reputation_delta": 0, "risk_delta": 0, "insight_delta": 0, "score_reason": { "reputation": "", "risk": "", "insight": "" } },
    { "id": "C", "text": "选项文字，不超过30字", "reputation_delta": 0, "risk_delta": 0, "insight_delta": 0, "score_reason": { "reputation": "", "risk": "", "insight": "" } },
    { "id": "D", "text": "选项文字，不超过30字", "reputation_delta": 0, "risk_delta": 0, "insight_delta": 0, "score_reason": { "reputation": "", "risk": "", "insight": "" } }
  ],
  "historical_note": "与当前场景相关的历史小知识，50-80字，附史料来源"
}`;
  }

  function buildConsequencePrompt(eventData, roleId, chosenOption, currentState, scoreImpact) {
    const char = eventData.characters[roleId];
    const roleName = char ? char.name : eventData.roles.find(r => r.id === roleId).name;
    const impactSummary = scoreImpact
      ? `\n本次分数变化：\n- 声望${scoreImpact.deltas.reputation > 0 ? '+' : ''}${scoreImpact.deltas.reputation} ${scoreImpact.reasons.reputation ? `（${scoreImpact.reasons.reputation}）` : ''}\n- 风险${scoreImpact.deltas.risk > 0 ? '+' : ''}${scoreImpact.deltas.risk} ${scoreImpact.reasons.risk ? `（${scoreImpact.reasons.risk}）` : ''}\n- 历史洞察${scoreImpact.deltas.insight > 0 ? '+' : ''}${scoreImpact.deltas.insight} ${scoreImpact.reasons.insight ? `（${scoreImpact.reasons.insight}）` : ''}`
      : '';

    return `玩家（${roleName}）选择了：「${chosenOption}」

当前状态：声望${currentState.reputation}/10，风险${currentState.risk}/10，历史洞察${currentState.insight}/10${impactSummary}

${buildTermAnnotationGuide(currentState)}

请生成选择的后果描述，要求：
1. 80-120字，第一人称，描写选择后立即发生的事情和你的感受
2. 后果必须符合历史逻辑，不能凭空创造不符合史实的结果
3. 后果要自然体现本次分数变化为何成立，但不要机械重复面板文案
4. 返回严格JSON，不要输出任何额外说明
5. JSON格式如下：
{
  "consequence": "后果正文",
  "consequence_annotations": [
    { "key": "专有名词唯一标识", "term": "consequence中出现的词", "category": "person/place/weapon/era/office/institution/event/other", "intro": "不超过300字的中文介绍" }
  ],
  "annotation_strategy": "可选字段，简要说明本段为何选择这些词，优先覆盖古称、古地名和不常用历史词"
}`;
  }

  function buildScenePrompt(eventData, roleId, act, scene, state) {
    const actData = resolveActs(eventData, roleId)[act - 1];
    const char = eventData.characters[roleId];
    const roleName = char ? char.name : eventData.roles.find(r => r.id === roleId).name;

    const scoreGuide = buildScoreNarrativeGuide(state);
    const lastScoreChangeGuide = buildLastScoreChangeGuide(state);

    // 上一场景的承接信息
    let bridgeSection = '';
    const ctx = state.lastSceneContext;
    if (ctx) {
      bridgeSection = `
【上一场景完整记录（必读，作为当前场景的起点）】
上一场景原文：
"${ctx.sceneText}"

玩家的选择：「${ctx.chosenOption}」
选择引发的后果：
"${ctx.consequenceText}"

【承上启下硬性要求（违反则重新生成）】
1. 当前场景的 scene 字段，开篇第一句话必须直接承接上一场景的后果，体现因果关系，禁止另起炉灶。
   - 正确示例："徐海的首级送抵杭州，胡总督看着那颗人头，知道这只是开始……"
   - 错误示例（禁止）："嘉靖四十年，台州烽烟四起……"（无视上文）
2. 如果本场景与上一场景发生了时间或地点的跳跃，必须在开篇2句话内，用过渡性语言交代清楚时间流逝与空间转换。
   - 正确示例："三个月后，你奉命离开台州，踏上了南下福建的官道……"
3. 人物状态要连贯：玩家选择带来的心理变化、声望变化或人际关系变化，需在场景中有所体现。
`;
    }

    return `现在是第${act}幕「${actData.title}」，第${scene + 1}个场景。
历史时间：${actData.year}
本幕核心事件：${actData.key_event}
本幕主题：${actData.summary}

玩家角色：${roleName}
当前状态：声望${state.reputation}/10，风险${state.risk}/10，历史洞察${state.insight}/10
${scoreGuide}
${lastScoreChangeGuide}
${buildTermAnnotationGuide(state)}
${bridgeSection}
${scene === 0 && act === 1 ? `这是游戏开场，请以引人入胜的方式建立场景氛围和角色处境。` : ''}
${act === 4 && scene === 2 ? `这是最后一个场景，请设计一个有分量的收尾抉择，为结局埋下伏笔。` : ''}

请根据以上信息生成当前场景，严格按照JSON格式输出。`;
  }

  // 生成与当前场景强相关的单条小贴士（并行发出，不阻塞主场景）
  function buildTipMessages(eventData, roleId, act, scene, state) {
    const actData = resolveActs(eventData, roleId)[act - 1];

    // 注入上一场景的具体内容，确保每次小贴士都不同
    let lastSceneInfo = '';
    const ctx = state && state.lastSceneContext;
    if (ctx) {
      lastSceneInfo = `
上一场景发生的事情：${ctx.sceneText ? ctx.sceneText.slice(0, 150) : ''}
玩家的选择：${ctx.chosenOption || ''}
选择引发的后果：${ctx.consequenceText ? ctx.consequenceText.slice(0, 150) : ''}`;
    }

    return [
      {
        role: 'system',
        content: '你是一个明史专家，擅长用简洁生动的语言介绍历史知识。请严格按要求输出，不要加任何前缀或说明。'
      },
      {
        role: 'user',
        content: `当前游戏处于"${actData.title}"阶段（第${act}幕第${scene + 1}场），核心事件是：${actData.key_event}。
历史背景：${actData.summary}${lastSceneInfo}

请根据上一场景刚刚发生的具体事件，生成一条与之直接相关的历史小贴士。要求：
1. 必须针对上一场景中出现的具体人物、地点、器物或事件展开，不得泛泛而谈
2. 每次生成内容必须不同，角度可以是：史料记载、兵器战法、官制礼仪、人物生平、地理地貌等
3. 字数在50到120字之间，语言简洁生动
4. 只输出贴士正文，不要加"小贴士："等前缀标签`
      }
    ];
  }

  function buildMessages(eventData, roleId, act, scene, state) {
    const systemPrompt = buildSystemPrompt(eventData, roleId);
    const userPrompt = buildScenePrompt(eventData, roleId, act, scene, state);

    // 构建消息列表：system + 历史对话 + 当前请求
    const messages = [
      { role: 'system', content: systemPrompt },
      ...state.history,
      { role: 'user', content: userPrompt }
    ];

    return messages;
  }

  function buildConsequenceMessages(eventData, roleId, chosenOption, state, scoreImpact) {
    const systemPrompt = buildSystemPrompt(eventData, roleId);
    const userPrompt = buildConsequencePrompt(eventData, roleId, chosenOption, state, scoreImpact);
    return [
      { role: 'system', content: systemPrompt },
      ...state.history.slice(-4),
      { role: 'user', content: userPrompt }
    ];
  }

  function buildEndingMessages(eventData, roleId, state) {
    const char = eventData.characters[roleId];
    const roleName = char ? char.name : eventData.roles.find(r => r.id === roleId).name;
    const choicesSummary = state.choices.map((c, i) => `第${i+1}次选择：${c.optionText}`).join('\n');

    const systemPrompt = buildSystemPrompt(eventData, roleId);
    const userPrompt = `游戏结束，请为玩家生成结局。

角色：${roleName}
最终状态：声望${state.reputation}/10，风险${state.risk}/10，历史洞察${state.insight}/10
玩家历次选择：
${choicesSummary}

请生成以下内容（JSON格式）：
{
  "ending_title": "结局标题，8字以内",
  "personal_ending": "玩家的个人命运结局，200字左右，第一人称，有情感厚度",
  "historical_truth": "这段历史的真实结局，150字左右，客观叙述",
  "epitaph": "一句话墓志铭或人生感悟，20字以内"
}`;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
  }

  return { buildMessages, buildConsequenceMessages, buildEndingMessages, buildTipMessages };
})();
