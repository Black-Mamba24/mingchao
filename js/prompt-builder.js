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

  function buildAnnotationCandidateSchema(textFieldName) {
    return `[
    {
      "key": "唯一标识",
      "term": "${textFieldName}中的原词",
      "category": "person/place/weapon/era/office/institution/event/other",
      "intro": "中文介绍，字数必须按 category 分档：person 类 180 到 260 字；place/era/office/institution 类 120 到 180 字；weapon/event/other 类 100 到 160 字",
      "scores": {
        "decision_relevance": 0,
        "context_impact": 0,
        "historical_specificity": 0,
        "archaicness": 0,
        "modern_unfamiliarity": 0,
        "ambiguity": 0,
        "specificity": 0,
        "information_gain": 0
      }
    }
  ]`;
  }

  function buildTermAnnotationGuide(state) {
    const introducedTerms = Array.isArray(state.introducedTerms)
      ? state.introducedTerms.map(normalizeTermKey).filter(Boolean)
      : [];

    return `【名词解释输出要求】
- 为 scene、npc_dialogue、question、consequence 生成结构化 annotations
- 可解释对象限定为以下类别之一：历史人物、古地名、古称、年号、职位、机构、事件、军械、直接影响当前抉择理解的生僻历史词
- 每个文本块返回 6 到 8 个 annotation candidates，前端最终展示上限为 5 个
- 候选召回优先级：关键人物 > 古称/古地名 > 具体旧称 > 生僻历史词 > 其他；常识词与泛称必须排在最末
- 同句若同时出现泛称与更具体词，更具体词的 decision_relevance 必须比泛称高 0.2 以上
- term 必须与原文字面完全一致；key 必须跨场景稳定
- intro 用中文，字数按 category 分档：person 类 180 到 260 字；place/era/office/institution 类 120 到 180 字；weapon/event/other 类 100 到 160 字
- 同一文本块同一词只返回一次；冗余候选数量上限为 2 个
- 已介绍词不必禁返，但所有 8 个维度分数必须在原分基础上统一下调 0.3：${introducedTerms.length ? introducedTerms.join('、') : '（暂无）'}
- 不允许为 options 中出现的任何词生成解释
- 每个 candidate 都必须填写 scores，8个维度都用 0 到 1 的小数：decision_relevance、context_impact、historical_specificity、archaicness、modern_unfamiliarity、ambiguity、specificity、information_gain`;
  }

  function buildScoreNarrativeGuide(state) {
    const guides = [];

    if (state.reputation >= 8) {
      guides.push('【声望态势】你的名声已高涨。当前场景中，至少一名NPC或机构必须明确表现出信任、倚重、让你承担更大责任，选项中必须出现号召、说服、调度、统御型行动中的至少一种。');
    } else if (state.reputation <= 3) {
      guides.push('【声望态势】你的声望处于 0 到 3 档。当前场景必须出现被质疑、被掣肘、需要自证的具体情节，高杠杆号令型选项数量必须降到 1 个以内。');
    } else {
      guides.push('【声望态势】你的声望处于 4 到 7 档。当前场景中，他人对你既有观察也有保留，任何支持型 NPC 给出的帮助都必须附带可执行的前置条件。');
    }

    if (state.risk >= 8) {
      guides.push('【风险态势】你的风险处于 8 到 10 档。当前场景必须出现以下压力信号中的至少一种：监视、追击、弹劾、怀疑、暴露、军令催逼；选项中必须出现掩护、撤退、转移视线或铤而走险中的至少一种。');
    } else if (state.risk <= 3) {
      guides.push('【风险态势】你的风险处于 0 到 3 档。当前局势有回旋余地，但场景中必须埋入至少一条未来可被放大的隐患线索。');
    } else {
      guides.push('【风险态势】你的风险处于 4 到 7 档。当前场景必须体现气氛收紧、后果逼近或有具体人物开始留意你的举动。');
    }

    if (state.insight >= 8) {
      guides.push('【洞察态势】你的历史洞察处于 8 到 10 档。当前场景必须揭示至少一条更深层的动机、陷阱、权力关系或隐藏信息，选项中必须出现识破、试探、设局、借势中的至少一种。');
    } else if (state.insight <= 3) {
      guides.push('【洞察态势】你的历史洞察处于 0 到 3 档。当前场景的信息必须保持模糊，至少一个选项必须隐藏误导项或错判风险。');
    } else {
      guides.push('【洞察态势】你的历史洞察处于 4 到 7 档。当前场景必须让你察觉到 1 条端倪，同时禁止一次看透全局。');
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
      ? `\n【导演模式说明】\n玩家扮演流亡的建文帝朱允炆，拥有「历史导演权」。在尊重明代地理常识与时代背景的前提下，允许虚构未被正史记载的人物、事件、路线，让玩家自行书写历史结局。场景鼓励奇思妙想，但必须同时满足以下三条硬性边界：\n  1. 不得出现 1644 年以后才出现的科技产物（含但不限于：电力、蒸汽机、内燃机、照相、电报、抗生素、塑料）\n  2. 不得违反明代已知的山川地貌与行政区划（如将黄河、长江的走向改写，或将嘉峪关搬至海边）\n  3. 不得引入 1644 年以后才出现的社会制度与专有概念（如宪法、政党、议会、义务教育、股份公司、现代警察）；明代已有的思想流派（心学、事功学、经世致用等）与制度雏形（市舶司、卫所、票拟等）可以自由演绎`
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

【人物解释补充要求】
- scene_annotations 与 npc_annotations 必须优先覆盖当前场景的核心人物，核心人物定义为：scene 中直接点名、且直接影响本场局势判断的人物
- 如果一句话里出现 2 名以上人物，必须先解释主冲突人物，其次才是地名或机构；当 5 个名额不足时，配角可不出现在 annotations 中
- 当 category=person 且 decision_relevance ≥ 0.7 时，人物 intro 必须按以下三段式作答：第一段写“他是谁”，第二段写“在这段历史里扮演什么角色”，第三段写“为何此刻重要”
- 其他 category 或 decision_relevance < 0.7 的 annotation 允许自然成文，但必须在首句点明该词条的核心属性（身份/地点性质/器物用途/事件年份等）

delta 取值范围：-2 到 +2，反映该选择对声望、风险、历史洞察的影响。

【分数变化说明要求】
- 每个选项都必须填写 score_reason
- 对于 delta 不为 0 的维度，必须解释“为什么会变”，每条解释字数必须落在 8 到 20 字区间内
- 解释必须使用剧情内因果，禁止出现“因为加了1点声望”这种元话术
- 若某维度 delta 为 0，该维度 score_reason 必须为空字符串
- 后续场景与选项设计必须参考玩家当前的声望、风险、历史洞察，禁止只在旁白里提到数值；必须在人物态度、局势压力、信息开放程度、可行动作类型这四项中至少改变一项`;
  }

  function buildSceneOutputSchema() {
    return `{
  "scene": "场景描述，字数必须落在 150 到 250 字区间内，第一人称沉浸式叙述，必须覆盖环境、情境、当前处境三项要素",
  "scene_annotations": [
    { "key": "专有名词唯一标识", "term": "scene中出现的词", "category": "person/place/weapon/era/office/institution/event/other", "intro": "中文介绍，字数按 category 分档：person 类 180 到 260 字；place/era/office/institution 类 120 到 180 字；weapon/event/other 类 100 到 160 字" }
  ],
  "scene_annotation_candidates": ${buildAnnotationCandidateSchema('scene')},
  "npc_dialogue": "当前场景中重要NPC的一句话，字数上限 50 字；如无NPC则必须为空字符串",
  "npc_annotations": [
    { "key": "专有名词唯一标识", "term": "npc_dialogue中出现的词", "category": "person/place/weapon/era/office/institution/event/other", "intro": "中文介绍，字数按 category 分档：person 类 180 到 260 字；place/era/office/institution 类 120 到 180 字；weapon/event/other 类 100 到 160 字" }
  ],
  "npc_annotation_candidates": ${buildAnnotationCandidateSchema('npc_dialogue')},
  "npc_name": "说话的NPC姓名；如无则必须为空字符串",
  "question": "当前你面临的核心抉择，必须以问号结尾的单句，字数上限 40 字",
  "question_annotations": [
    { "key": "专有名词唯一标识", "term": "question中出现的词", "category": "person/place/weapon/era/office/institution/event/other", "intro": "中文介绍，字数按 category 分档：person 类 180 到 260 字；place/era/office/institution 类 120 到 180 字；weapon/event/other 类 100 到 160 字" }
  ],
  "question_annotation_candidates": ${buildAnnotationCandidateSchema('question')},
  "annotation_strategy": "必填字段，用一句话说明本段召回规则，字数上限 40 字，必须点名优先覆盖的类别（古称/古地名/不常用历史词/更具体的旧称中的至少一类）",
  "options": [
    { "id": "A", "text": "选项文字，字数上限 30 字", "reputation_delta": 0, "risk_delta": 0, "insight_delta": 0, "score_reason": { "reputation": "", "risk": "", "insight": "" } },
    { "id": "B", "text": "选项文字，字数上限 30 字", "reputation_delta": 0, "risk_delta": 0, "insight_delta": 0, "score_reason": { "reputation": "", "risk": "", "insight": "" } },
    { "id": "C", "text": "选项文字，字数上限 30 字", "reputation_delta": 0, "risk_delta": 0, "insight_delta": 0, "score_reason": { "reputation": "", "risk": "", "insight": "" } },
    { "id": "D", "text": "选项文字，字数上限 30 字", "reputation_delta": 0, "risk_delta": 0, "insight_delta": 0, "score_reason": { "reputation": "", "risk": "", "insight": "" } }
  ],
  "historical_note": "与当前场景相关的历史小知识，字数必须落在 50 到 80 字区间内，末尾必须附史料来源"
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
1. 字数必须落在 80 到 120 字区间内，第一人称，必须描写选择后立即发生的事件与第一人称感受
2. 后果必须符合历史逻辑，禁止创造不符合史实的结果
3. 后果必须自然体现本次分数变化为何成立，禁止机械重复面板文案
4. scene 与 consequence 的 annotation 策略必须保持一致，候选池按相同标准召回并打分
5. 返回严格 JSON，禁止输出任何额外说明
6. JSON 格式如下：
{
  "consequence": "后果正文",
  "consequence_annotations": [
    { "key": "专有名词唯一标识", "term": "consequence中出现的词", "category": "person/place/weapon/era/office/institution/event/other", "intro": "中文介绍，字数按 category 分档：person 类 180 到 260 字；place/era/office/institution 类 120 到 180 字；weapon/event/other 类 100 到 160 字" }
  ],
  "consequence_annotation_candidates": ${buildAnnotationCandidateSchema('consequence')},
  "annotation_strategy": "必填字段，用一句话说明本段召回规则，字数上限 40 字，必须点名优先覆盖的类别（古称/古地名/不常用历史词/更具体的旧称中的至少一类）"
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
3. 人物状态必须连贯：玩家选择带来的心理变化、声望变化或人际关系变化中的至少一项，必须在当前场景 scene 文本内通过具体动作、对白或 NPC 反应呈现。
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
${scene === 0 && act === 1 ? `这是游戏开场，开篇第一句必须使用具体的感官细节（光线、声音、气味、温度、器物中的至少一项）建立场景氛围，并在前 3 句内交代玩家当前所处的具体地点与身份处境。` : ''}
${act === 4 && scene === 2 ? `这是最后一个场景，必须设计一个直接关系到本次结局走向的收尾抉择，4 个选项中必须至少有 1 个对应“主动承担后果”方向，并至少有 1 个对应“规避后果”方向，为结局埋下伏笔。` : ''}

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
        content: '你是一个明史专家，必须用第三人称客观语气介绍历史知识。严格按要求输出，禁止添加任何前缀、后缀或说明。'
      },
      {
        role: 'user',
        content: `当前游戏处于"${actData.title}"阶段（第${act}幕第${scene + 1}场），核心事件是：${actData.key_event}。
历史背景：${actData.summary}${lastSceneInfo}

请根据上一场景刚刚发生的具体事件，生成一条与之直接相关的历史小贴士。要求：
1. 必须针对上一场景中出现的具体人物、地点、器物或事件展开，禁止泛泛而谈
2. 每次生成的内容必须与历史不同，角度必须从以下五类中任选一类：史料记载、兵器战法、官制礼仪、人物生平、地理地貌
3. 字数必须落在 50 到 120 字区间内
4. 必须包含一个可查证的史实锚点（年号、人物、书名、地名中的至少一项）
5. 只输出贴士正文，禁止添加"小贴士："等前缀标签`
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
  "ending_title": "结局标题，字数上限 8 字",
  "personal_ending": "玩家的个人命运结局，字数必须落在 180 到 220 字区间内，第一人称，必须包含一处具体事件细节（时间、地点、他人反应中的至少一项）",
  "historical_truth": "这段历史的真实结局，字数必须落在 130 到 170 字区间内，第三人称客观叙述，必须以可查证的史实为依据",
  "epitaph": "一句话墓志铭或人生感悟，字数上限 20 字"
}`;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];
  }

  return { buildMessages, buildConsequenceMessages, buildEndingMessages, buildTipMessages };
})();
