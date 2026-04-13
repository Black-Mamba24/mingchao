/**
 * PromptBuilder — 历史约束包构建器
 * 将历史数据库 + 玩家状态 + 对话历史组装成 LLM 请求
 */
const PromptBuilder = (() => {

  function buildSystemPrompt(eventData, roleId) {
    const role = eventData.roles.find(r => r.id === roleId);
    const char = eventData.characters[roleId];
    const facts = eventData.historical_facts.join('\n- ');
    const constraints = eventData.constraints.join('\n- ');

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

【核心历史史实（必须遵守，不得篡改）】
- ${facts}

【生成约束（严格执行）】
- ${constraints}
- 不得改变任何历史大事件的结果
- 所有内容必须符合明代嘉靖年间的文化、礼制、语言习惯
- 禁止使用现代词汇和现代概念
- 每次生成必须返回严格的 JSON 格式，不得有任何前缀说明文字

【输出格式（严格JSON）】
{
  "scene": "场景描述，150-250字，第一人称沉浸式叙述，描写环境、情境、你当前面临的处境",
  "npc_dialogue": "当前场景中重要NPC的一句话（如无NPC则为空字符串）",
  "npc_name": "说话的NPC姓名（如无则为空字符串）",
  "question": "当前你面临的核心抉择，用一个简洁的问句表达",
  "options": [
    { "id": "A", "text": "选项文字，不超过30字", "reputation_delta": 0, "risk_delta": 0, "insight_delta": 0 },
    { "id": "B", "text": "选项文字，不超过30字", "reputation_delta": 0, "risk_delta": 0, "insight_delta": 0 },
    { "id": "C", "text": "选项文字，不超过30字", "reputation_delta": 0, "risk_delta": 0, "insight_delta": 0 },
    { "id": "D", "text": "选项文字，不超过30字", "reputation_delta": 0, "risk_delta": 0, "insight_delta": 0 }
  ],
  "historical_note": "与当前场景相关的历史小知识，50-80字，附史料来源"
}

delta 取值范围：-2 到 +2，反映该选择对声望、风险、历史洞察的影响。`;
  }

  function buildConsequencePrompt(eventData, roleId, chosenOption, currentState) {
    const char = eventData.characters[roleId];
    const roleName = char ? char.name : eventData.roles.find(r => r.id === roleId).name;

    return `玩家（${roleName}）选择了：「${chosenOption}」

当前状态：声望${currentState.reputation}/10，风险${currentState.risk}/10，历史洞察${currentState.insight}/10

请生成选择的后果描述，要求：
1. 80-120字，第一人称，描写选择后立即发生的事情和你的感受
2. 后果必须符合历史逻辑，不能凭空创造不符合史实的结果
3. 只返回后果文字，不需要JSON格式`;
  }

  function buildScenePrompt(eventData, roleId, act, scene, state) {
    const actData = eventData.acts[act - 1];
    const char = eventData.characters[roleId];
    const roleName = char ? char.name : eventData.roles.find(r => r.id === roleId).name;

    return `现在是第${act}幕「${actData.title}」，第${scene + 1}个场景。
历史时间：${actData.year}
本幕核心事件：${actData.key_event}
本幕主题：${actData.summary}

玩家角色：${roleName}
当前状态：声望${state.reputation}/10，风险${state.risk}/10，历史洞察${state.insight}/10

${scene === 0 && act === 1 ? `这是游戏开场，请以引人入胜的方式建立场景氛围和角色处境。` : ''}
${act === 4 && scene === 2 ? `这是最后一个场景，请设计一个有分量的收尾抉择，为结局埋下伏笔。` : ''}

请根据以上信息生成当前场景，严格按照JSON格式输出。`;
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

  function buildConsequenceMessages(eventData, roleId, chosenOption, state) {
    const systemPrompt = buildSystemPrompt(eventData, roleId);
    const userPrompt = buildConsequencePrompt(eventData, roleId, chosenOption, state);
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

  return { buildMessages, buildConsequenceMessages, buildEndingMessages };
})();
