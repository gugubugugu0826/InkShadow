import {
  sealNovelSkillDefinition,
  type NovelSkillDefinition,
  type NovelSkillDefinitionDraft,
} from "./novel-skill.js";

const CREATED_AT = "2026-08-10T00:00:00.000Z";

/**
 * Original InkShadow Core methods. They remain experimental and disabled until
 * the repository's Chinese fiction A/B gate has enough real provider evidence.
 */
export async function createCoreNovelSkillDefinitions(): Promise<readonly NovelSkillDefinition[]> {
  return Promise.all(CORE_NOVEL_SKILL_DRAFTS.map(sealNovelSkillDefinition));
}

export const CORE_NOVEL_SKILL_DRAFTS: readonly NovelSkillDefinitionDraft[] = [
  {
    skillId: "core.scene_craft",
    version: "1.0.0",
    displayName: "场景推进",
    summary: "让场景围绕可感知的目标、阻力和变化前进。",
    kind: "core",
    ownerScope: "builtin",
    status: "experimental",
    defaultEnabled: false,
    precedence: 500,
    taskTypes: [
      "book_start_guidance",
      "prose_generation",
      "continuation",
      "rewrite",
      "scene_breakdown",
    ],
    activation: {
      allowedModes: ["collaborator", "draft", "revision", "explorer"],
      genreTags: [],
      exclusiveGroup: null,
    },
    contextRequirements: {
      requiredLayers: ["current_task"],
      optionalLayers: ["scene_goal", "recent_events", "unresolved_foreshadowing"],
    },
    instructions: {
      rules: [
        {
          ruleId: "scene.objective",
          text: "让当前场景中的人物追求一个可观察的近期目标，并用阻力迫使其采取行动。",
        },
        {
          ruleId: "scene.change",
          text: "场景结束时至少改变信息、关系、位置、资源或人物决定中的一项，不用总结替代变化。",
        },
        {
          ruleId: "scene.entry_exit",
          text: "从正在发生的具体动作或感受进入，在新的压力、发现或选择形成后离开。",
        },
      ],
    },
    outputContract: {
      kind: "prose",
      rules: [{ ruleId: "scene.no_meta", text: "只输出任务要求的小说内容，不解释写作方法。" }],
    },
    validation: {
      rules: [
        {
          ruleId: "scene.change_check",
          text: "检查开头与结尾的故事状态是否存在可指出的变化。",
          evidenceRequired: true,
        },
      ],
    },
    provenance: { url: null, commit: null, license: null },
    createdAt: CREATED_AT,
  },
  {
    skillId: "core.character_dialogue",
    version: "1.0.0",
    displayName: "人物与对话",
    summary: "用人物当下目的和关系差异塑造行为与说话方式。",
    kind: "core",
    ownerScope: "builtin",
    status: "experimental",
    defaultEnabled: false,
    precedence: 500,
    taskTypes: ["prose_generation", "continuation", "rewrite", "polish", "character_voice_check"],
    activation: {
      allowedModes: ["collaborator", "draft", "critic", "revision"],
      genreTags: [],
      exclusiveGroup: null,
    },
    contextRequirements: {
      requiredLayers: ["current_task"],
      optionalLayers: ["character_current_state", "character_voice_samples", "recent_events"],
    },
    instructions: {
      rules: [
        {
          ruleId: "character.local_motive",
          text: "人物的动作和台词要服务于其在当前时刻的目的，并受既有关系与情绪约束。",
        },
        {
          ruleId: "dialogue.asymmetry",
          text: "让不同人物在用词、信息量、回避方式和回应节奏上保持可辨别差异。",
        },
        {
          ruleId: "dialogue.subtext",
          text: "能通过动作、停顿或答非所问表达的内容，不重复写成解释性台词。",
        },
      ],
    },
    outputContract: {
      kind: "prose",
      rules: [{ ruleId: "dialogue.no_labels", text: "不要在正文中标注人物声纹或对话技巧名称。" }],
    },
    validation: {
      rules: [
        {
          ruleId: "dialogue.voice_evidence",
          text: "判断说话方式是否偏离时，必须能对应到已提供的历史台词或明确人物设定。",
          evidenceRequired: true,
        },
      ],
    },
    provenance: { url: null, commit: null, license: null },
    createdAt: CREATED_AT,
  },
  {
    skillId: "core.pov_knowledge",
    version: "1.0.0",
    displayName: "视角与知情边界",
    summary: "只让叙述使用当前视角人物能够感知或合理推断的信息。",
    kind: "core",
    ownerScope: "builtin",
    status: "experimental",
    defaultEnabled: false,
    precedence: 500,
    taskTypes: ["prose_generation", "continuation", "rewrite", "polish", "pov_check"],
    activation: {
      allowedModes: ["collaborator", "draft", "critic", "revision"],
      genreTags: [],
      exclusiveGroup: null,
    },
    contextRequirements: {
      requiredLayers: ["current_task", "pov_known_information"],
      optionalLayers: ["character_current_state", "recent_events"],
    },
    instructions: {
      rules: [
        {
          ruleId: "pov.knowledge_boundary",
          text: "叙述不得把视角人物尚未知晓的事实写成其确定知识；猜测必须保留猜测性质。",
        },
        {
          ruleId: "pov.sensory_anchor",
          text: "优先通过视角人物当下可感知的细节呈现空间、人物反应和信息变化。",
        },
        {
          ruleId: "pov.no_head_hop",
          text: "同一限知场景内不要直接陈述其他人物未公开的内心活动。",
        },
      ],
    },
    outputContract: {
      kind: "prose",
      rules: [{ ruleId: "pov.keep_requested", text: "保持任务指定的叙事人称和视角范围。" }],
    },
    validation: {
      rules: [
        {
          ruleId: "pov.leak_check",
          text: "报告知情越界时指出具体句子、被泄露事实及人物获得该信息的时间或来源。",
          evidenceRequired: true,
        },
      ],
    },
    provenance: { url: null, commit: null, license: null },
    createdAt: CREATED_AT,
  },
  {
    skillId: "core.causality_continuity",
    version: "1.0.0",
    displayName: "因果与连续性",
    summary: "让新动作由既有状态触发，并产生可追踪的后果。",
    kind: "core",
    ownerScope: "builtin",
    status: "experimental",
    defaultEnabled: false,
    precedence: 500,
    taskTypes: [
      "outline_planning",
      "scene_breakdown",
      "prose_generation",
      "continuation",
      "rewrite",
      "contradiction_check",
      "what_if_simulation",
    ],
    activation: {
      allowedModes: ["collaborator", "draft", "critic", "revision", "explorer"],
      genreTags: [],
      exclusiveGroup: null,
    },
    contextRequirements: {
      requiredLayers: ["current_task"],
      optionalLayers: [
        "recent_events",
        "related_causal_chain",
        "character_current_state",
        "world_setting",
      ],
    },
    instructions: {
      rules: [
        {
          ruleId: "causality.trigger",
          text: "重大行动或转折必须能追溯到人物动机、已发生事件、已知信息或外部压力。",
        },
        {
          ruleId: "continuity.state",
          text: "延续人物位置、物品归属、关系、伤势、时间与已确认规则，不为方便推进而重置。",
        },
        {
          ruleId: "causality.consequence",
          text: "新事件应留下后果或新的约束，使后续情节能够引用而不是孤立发生。",
        },
      ],
    },
    outputContract: {
      kind: "mixed",
      rules: [
        { ruleId: "causality.no_new_fact", text: "缺少依据时不要补造正式事实来填补因果缺口。" },
      ],
    },
    validation: {
      rules: [
        {
          ruleId: "causality.evidence_chain",
          text: "指出因果或连续性问题时同时列出当前内容、冲突状态和来源。",
          evidenceRequired: true,
        },
      ],
    },
    provenance: { url: null, commit: null, license: null },
    createdAt: CREATED_AT,
  },
  {
    skillId: "core.prose_specificity",
    version: "1.0.0",
    displayName: "具体而克制的表达",
    summary: "用与场景相关的具体细节替代空泛评价，同时避免无依据扩写。",
    kind: "core",
    ownerScope: "builtin",
    status: "experimental",
    defaultEnabled: false,
    precedence: 500,
    taskTypes: ["book_start_guidance", "prose_generation", "continuation", "rewrite", "polish"],
    activation: {
      allowedModes: ["collaborator", "draft", "revision"],
      genreTags: [],
      exclusiveGroup: null,
    },
    contextRequirements: {
      requiredLayers: ["current_task"],
      optionalLayers: ["scene_goal", "world_setting", "character_voice_samples"],
    },
    instructions: {
      rules: [
        {
          ruleId: "prose.specific_detail",
          text: "选择能影响动作、判断或情绪的具体细节，不堆放与当前场景无关的装饰。",
        },
        {
          ruleId: "prose.show_claim",
          text: "重要评价尽量由可观察的动作、语言或后果支撑，不连续使用抽象总结。",
        },
        {
          ruleId: "prose.no_invention",
          text: "润色和改写不得为追求生动擅自增加人物经历、世界规则或剧情事实。",
        },
      ],
    },
    outputContract: {
      kind: "prose",
      rules: [{ ruleId: "prose.preserve_scope", text: "保持用户要求的改动范围和原有事实边界。" }],
    },
    validation: {
      rules: [
        {
          ruleId: "prose.invention_check",
          text: "检查新增具体细节是否可由现有内容支持，无法支持时标记为候选而非事实。",
          evidenceRequired: true,
        },
      ],
    },
    provenance: { url: null, commit: null, license: null },
    createdAt: CREATED_AT,
  },
  {
    skillId: "core.revision_discipline",
    version: "1.0.0",
    displayName: "受控修改",
    summary: "围绕明确修改目标工作，保留未授权变化并便于比较。",
    kind: "core",
    ownerScope: "builtin",
    status: "experimental",
    defaultEnabled: false,
    precedence: 500,
    taskTypes: ["rewrite", "polish"],
    activation: {
      allowedModes: ["collaborator", "revision"],
      genreTags: [],
      exclusiveGroup: null,
    },
    contextRequirements: {
      requiredLayers: ["current_task"],
      optionalLayers: ["locked_hard_rules", "pov_known_information", "character_voice_samples"],
    },
    instructions: {
      rules: [
        {
          ruleId: "revision.target",
          text: "只围绕本次明确修改目标调整文本，未要求改变的剧情事实、人物关系和叙事视角保持不变。",
        },
        {
          ruleId: "revision.minimum_change",
          text: "能用局部修改解决的问题不扩大为整段重写，避免把作者有意保留的表达统一化。",
        },
        {
          ruleId: "revision.no_silent_repair",
          text: "发现超出本次范围的问题时提出建议，不在候选文本中静默改写正式设定。",
        },
      ],
    },
    outputContract: {
      kind: "prose",
      rules: [
        {
          ruleId: "revision.candidate_only",
          text: "输出独立建议版本，不能宣称已覆盖或保存正式正文。",
        },
      ],
    },
    validation: {
      rules: [
        {
          ruleId: "revision.scope_diff",
          text: "检查每类变化能否对应本次目标，并把无对应依据的变化列为越界。",
          evidenceRequired: true,
        },
      ],
    },
    provenance: { url: null, commit: null, license: null },
    createdAt: CREATED_AT,
  },
  {
    skillId: "core.evidence_critique",
    version: "1.0.0",
    displayName: "有证据的审稿",
    summary: "把审稿结论绑定到原文、正式事实或可验证结构指标。",
    kind: "core",
    ownerScope: "builtin",
    status: "experimental",
    defaultEnabled: false,
    precedence: 500,
    taskTypes: [
      "contradiction_check",
      "pov_check",
      "character_voice_check",
      "content_quality_check",
    ],
    activation: {
      allowedModes: ["coach", "critic", "revision"],
      genreTags: [],
      exclusiveGroup: null,
    },
    contextRequirements: {
      requiredLayers: ["current_task"],
      optionalLayers: [
        "locked_hard_rules",
        "pov_known_information",
        "character_voice_samples",
        "related_causal_chain",
      ],
    },
    instructions: {
      rules: [
        {
          ruleId: "critique.claim_evidence",
          text: "每个问题结论都要指向具体原文和与之冲突的设定、历史片段或结构指标。",
        },
        {
          ruleId: "critique.uncertainty",
          text: "证据不足时说明缺少什么，不把模型推测包装成确定缺陷。",
        },
        {
          ruleId: "critique.action",
          text: "建议应说明最小修复方向，并区分修改正文、忽略问题和更新正式设定。",
        },
      ],
    },
    outputContract: {
      kind: "analysis",
      rules: [{ ruleId: "critique.no_rewrite", text: "除非任务明确要求，不直接重写整段正文。" }],
    },
    validation: {
      rules: [
        {
          ruleId: "critique.traceability",
          text: "缺少原文定位或冲突来源的结论不得标记为已证实问题。",
          evidenceRequired: true,
        },
      ],
    },
    provenance: { url: null, commit: null, license: null },
    createdAt: CREATED_AT,
  },
] as const;
