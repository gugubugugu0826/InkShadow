import {
  sealNovelSkillDefinition,
  type NovelSkillDefinition,
  type NovelSkillDefinitionDraft,
} from "./novel-skill.js";

const CREATED_AT = "2026-08-10T00:00:00.000Z";

/**
 * Original InkShadow genre methods. Genre methods remain opt-in experiments;
 * a matching ProjectSeed may recommend one but can never enable or bind it.
 */
export async function createGenreNovelSkillDefinitions(): Promise<readonly NovelSkillDefinition[]> {
  return Promise.all(GENRE_NOVEL_SKILL_DRAFTS.map(sealNovelSkillDefinition));
}

export const GENRE_NOVEL_SKILL_DRAFTS: readonly NovelSkillDefinitionDraft[] = [
  {
    skillId: "genre.campus_romance",
    version: "1.0.0",
    displayName: "校园青春恋爱",
    summary: "用共同日常、关系距离和未说出口的选择推进校园恋爱故事。",
    kind: "genre",
    ownerScope: "builtin",
    status: "experimental",
    defaultEnabled: false,
    precedence: 400,
    taskTypes: [
      "book_start_guidance",
      "prose_generation",
      "continuation",
      "rewrite",
      "outline_planning",
      "scene_breakdown",
    ],
    activation: {
      allowedModes: ["coach", "collaborator", "draft", "revision", "explorer"],
      genreTags: ["campus_romance"],
      exclusiveGroup: null,
    },
    contextRequirements: {
      requiredLayers: ["current_task"],
      optionalLayers: [
        "scene_goal",
        "character_current_state",
        "recent_events",
        "character_voice_samples",
      ],
    },
    instructions: {
      rules: [
        {
          ruleId: "campus_romance.shared_routine",
          text: "优先从课程、社团、通学、考试或同伴关系等共同日常制造必须相处的具体情境。",
        },
        {
          ruleId: "campus_romance.distance_change",
          text: "每次关系推进要落在称呼、站位、共享秘密、主动选择或回避方式等可观察变化上。",
        },
        {
          ruleId: "campus_romance.mutual_agency",
          text: "双方都保留自己的目标和选择，不把误会拖延或单方面牺牲当作唯一推进方式。",
        },
      ],
    },
    outputContract: {
      kind: "prose",
      rules: [
        {
          ruleId: "campus_romance.no_template_role",
          text: "不因题材标签擅自套用固定男女主性格、学校制度或地域文化。",
        },
      ],
    },
    validation: {
      rules: [
        {
          ruleId: "campus_romance.relation_evidence",
          text: "判断关系升温或疏远时，指出本场新增的具体行为、话语或共同经历。",
          evidenceRequired: true,
        },
      ],
    },
    provenance: { url: null, commit: null, license: null },
    createdAt: CREATED_AT,
  },
  {
    skillId: "genre.light_novel",
    version: "1.0.0",
    displayName: "轻小说节奏",
    summary: "用清晰主视角、轻快交互和段落落点保持易读而不失人物真实。",
    kind: "genre",
    ownerScope: "builtin",
    status: "experimental",
    defaultEnabled: false,
    precedence: 400,
    taskTypes: [
      "book_start_guidance",
      "prose_generation",
      "continuation",
      "rewrite",
      "polish",
      "scene_breakdown",
    ],
    activation: {
      allowedModes: ["coach", "collaborator", "draft", "revision"],
      genreTags: ["light_novel"],
      exclusiveGroup: null,
    },
    contextRequirements: {
      requiredLayers: ["current_task"],
      optionalLayers: [
        "scene_goal",
        "pov_known_information",
        "character_voice_samples",
        "recent_events",
      ],
    },
    instructions: {
      rules: [
        {
          ruleId: "light_novel.viewpoint_reaction",
          text: "让主视角对新信息产生有个性的即时判断或反应，但不替读者解释已经清楚的笑点和情绪。",
        },
        {
          ruleId: "light_novel.exchange_rhythm",
          text: "在对话、动作和短暂内心反应之间换气，使信息交换有落点而不是连续堆台词。",
        },
        {
          ruleId: "light_novel.scene_turn",
          text: "用一个新的期待、尴尬、发现或关系变化结束段落单元，避免只靠夸张语气制造速度。",
        },
      ],
    },
    outputContract: {
      kind: "prose",
      rules: [
        {
          ruleId: "light_novel.no_cultural_invention",
          text: "轻小说标签不授权擅自添加日式姓名、制度、宅文化梗或固定角色属性。",
        },
      ],
    },
    validation: {
      rules: [
        {
          ruleId: "light_novel.voice_and_pov_check",
          text: "检查轻快表达是否仍符合既有人物声纹、叙事人称和知情边界。",
          evidenceRequired: true,
        },
      ],
    },
    provenance: { url: null, commit: null, license: null },
    createdAt: CREATED_AT,
  },
  {
    skillId: "genre.mystery",
    version: "1.0.0",
    displayName: "悬疑与推理",
    summary: "管理线索可见性、人物解释和揭示顺序，让疑问来自可追踪证据。",
    kind: "genre",
    ownerScope: "builtin",
    status: "experimental",
    defaultEnabled: false,
    precedence: 400,
    taskTypes: [
      "book_start_guidance",
      "prose_generation",
      "continuation",
      "rewrite",
      "outline_planning",
      "scene_breakdown",
      "contradiction_check",
      "pov_check",
    ],
    activation: {
      allowedModes: ["coach", "collaborator", "draft", "critic", "revision", "explorer"],
      genreTags: ["mystery"],
      exclusiveGroup: null,
    },
    contextRequirements: {
      requiredLayers: ["current_task"],
      optionalLayers: [
        "pov_known_information",
        "recent_events",
        "related_causal_chain",
        "unresolved_foreshadowing",
      ],
    },
    instructions: {
      rules: [
        {
          ruleId: "mystery.clue_observability",
          text: "关键线索首次出现时必须能由当前视角感知，之后的解释不能反向补造未呈现的决定性细节。",
        },
        {
          ruleId: "mystery.interpretation_gap",
          text: "区分线索本身、人物当时的解释和事后真相，使误导来自合理视角而非隐瞒已知事实。",
        },
        {
          ruleId: "mystery.reveal_consequence",
          text: "揭示应改变人物判断、风险或行动方向，并能追溯到先前证据链。",
        },
      ],
    },
    outputContract: {
      kind: "mixed",
      rules: [
        {
          ruleId: "mystery.no_unearned_solution",
          text: "没有足够证据时不宣布唯一真相，也不为完成推理临时增加关键证物。",
        },
      ],
    },
    validation: {
      rules: [
        {
          ruleId: "mystery.clue_trace",
          text: "检查推断时列出线索出现位置、当时可知范围以及推断跨越的每一步。",
          evidenceRequired: true,
        },
      ],
    },
    provenance: { url: null, commit: null, license: null },
    createdAt: CREATED_AT,
  },
  {
    skillId: "genre.fantasy",
    version: "1.0.0",
    displayName: "奇幻规则与代价",
    summary: "让超常能力、世界规则和解决方案保持边界、代价与连续后果。",
    kind: "genre",
    ownerScope: "builtin",
    status: "experimental",
    defaultEnabled: false,
    precedence: 400,
    taskTypes: [
      "book_start_guidance",
      "prose_generation",
      "continuation",
      "rewrite",
      "outline_planning",
      "scene_breakdown",
      "world_extraction",
      "contradiction_check",
      "what_if_simulation",
    ],
    activation: {
      allowedModes: ["coach", "collaborator", "draft", "critic", "revision", "explorer"],
      genreTags: ["fantasy"],
      exclusiveGroup: null,
    },
    contextRequirements: {
      requiredLayers: ["current_task"],
      optionalLayers: [
        "locked_hard_rules",
        "world_setting",
        "character_current_state",
        "related_causal_chain",
      ],
    },
    instructions: {
      rules: [
        {
          ruleId: "fantasy.rule_before_solution",
          text: "超常手段解决关键困难前，要能对应到已建立的能力、资源、条件或可验证线索。",
        },
        {
          ruleId: "fantasy.cost_and_limit",
          text: "强力能力保留明确限制、代价或风险，且代价会影响人物之后的可选行动。",
        },
        {
          ruleId: "fantasy.world_reaction",
          text: "世界中的制度、群体和人物要对公开发生的超常事件产生符合既有规则的反应。",
        },
      ],
    },
    outputContract: {
      kind: "mixed",
      rules: [
        {
          ruleId: "fantasy.no_convenient_lore",
          text: "不得为解除当前困境临时发明与现有设定无来源的新规则、神器或血统。",
        },
      ],
    },
    validation: {
      rules: [
        {
          ruleId: "fantasy.rule_evidence",
          text: "检查能力或世界规则时引用正式设定、先前事件或当前明确提供的证据。",
          evidenceRequired: true,
        },
      ],
    },
    provenance: { url: null, commit: null, license: null },
    createdAt: CREATED_AT,
  },
  {
    skillId: "genre.web_serial",
    version: "1.0.0",
    displayName: "网络连载推进",
    summary: "让章节持续兑现近期目标、累积变化并留下清晰但不重复的后续动力。",
    kind: "genre",
    ownerScope: "builtin",
    status: "experimental",
    defaultEnabled: false,
    precedence: 400,
    taskTypes: [
      "book_start_guidance",
      "prose_generation",
      "continuation",
      "rewrite",
      "outline_planning",
      "scene_breakdown",
      "content_quality_check",
    ],
    activation: {
      allowedModes: ["coach", "collaborator", "draft", "critic", "revision", "explorer"],
      genreTags: ["web_serial"],
      exclusiveGroup: null,
    },
    contextRequirements: {
      requiredLayers: ["current_task"],
      optionalLayers: [
        "scene_goal",
        "recent_events",
        "related_causal_chain",
        "unresolved_foreshadowing",
      ],
    },
    instructions: {
      rules: [
        {
          ruleId: "web_serial.promise_payoff",
          text: "每章至少推进或兑现一个读者已经能识别的近期目标、疑问或承诺。",
        },
        {
          ruleId: "web_serial.progressive_pressure",
          text: "新的阻力要改变解决条件或抬高选择代价，不用同类误会、战斗或受辱反复归零。",
        },
        {
          ruleId: "web_serial.next_momentum",
          text: "章节结尾留下由本章结果自然产生的下一步动力，不强迫每章使用突发危险式悬崖。",
        },
      ],
    },
    outputContract: {
      kind: "mixed",
      rules: [
        {
          ruleId: "web_serial.no_filler",
          text: "不以重复说明、无状态变化的冲突或拆短场景填充连载篇幅。",
        },
      ],
    },
    validation: {
      rules: [
        {
          ruleId: "web_serial.chapter_delta",
          text: "检查本章相对开头新增、兑现或改变了什么，并指出对应段落。",
          evidenceRequired: true,
        },
      ],
    },
    provenance: { url: null, commit: null, license: null },
    createdAt: CREATED_AT,
  },
] as const;
