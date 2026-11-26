// 独立任务助手配置数据。与「任务助手-世界书.ejs」开头的 _data 保持同一份口径。

export const DATA_VERSION = 1;

export const DATA = {
  questBoard: {
    /** 主动请求下一回合重扫本地情报消耗的 FP。 */
    rescanFp: 100,
    /** 剧情任务未接取时，搁置满该世界日数即触发一次自然推进。 */
    storyAdvanceDays: 5,
    /**
     * 三大类别：建议上限、品质偏移（+1 为在 <任务与委托规则> 基础上上调 1 档）、
     * 固定预期收益栏位数与跨区保留规则。
     */
    categories: {
      剧情任务: { max: 2, rewardSlots: 7, qualityShift: 1, crossRegion: true },
      本地主线: { max: 2, rewardSlots: 5, qualityShift: 1, crossRegion: false },
      支线任务: { max: 3, rewardSlots: 3, qualityShift: 0, crossRegion: false },
    },
    maxItems: 7,
    maxIgnored: 12,
    /**
     * 地区事件钩子表（仅含不剧透的公开风声入口）。
     * EJS 按当前所在区域、等级与完成状态过滤，不在对应区域或已完成时 0 token 注入。
     */
    eventHooks: [
      {
        id: 'mountains',
        regions: ['铁炉堡', '巨龙山脉'],
        category: '剧情任务',
        rank: 'A',
        doneEvent: '已完成事件关于我帮助矮人王女夺回群山王国的那些事',
        maxLevel: 14,
        way: '委托',
        rumor: '矮人王女艾波丽斯正在铁炉堡召集「铁砧之誓」远征队，高酬招募盟友参与夺回失落群山王国沃达坦的远征',
      },
      {
        id: 'blood_princess',
        regions: ['瓦伦蒂亚', '诺瓦·瓦伦蒂亚'],
        category: '剧情任务',
        rank: 'B',
        doneEvent: '已完成事件关于我战败后被血族女王变成女儿的那些事',
        maxLevel: 7,
        way: '悬赏',
        rumor: '瓦伦蒂亚城内流传着针对古老血族始祖莉莉娅丝的高额讨伐悬赏与征召令，公会与军方均在暗中物色人手',
      },
      {
        id: 'porcelain_room',
        regions: ['锈潮港区', '雾晶港'],
        category: '本地主线',
        rank: 'B',
        doneSignal: '密室_completed',
        way: '探索',
        rumor: '锈潮港区崖壁近日露出一条人工打磨的白石裂缝，传闻深处遗留着古代素瓷密室与不明魔法器',
      },
      {
        id: 'ice_song',
        regions: ['北境', '碎冕冰脊', '冰峨镇', '白曜城', '诺斯加德'],
        category: '剧情任务',
        rank: 'A',
        doneFlag: ['冰之歌', '异神已击败'],
        minLevel: 10,
        way: '异象',
        rumor: '北境极寒地带近日频现反常寒潮与古老咏叹异象，多支前去探查的商队与斥候均称风雪中藏有异常源头',
      },
      {
        id: 'sphinx',
        regions: ['沙漠', '沼泽', '树海', '荒野', '山脉', '废墟'],
        category: '本地主线',
        rank: 'A',
        doneSignal: '斯芬克斯支线_done0231',
        way: '探索',
        rumor: '荒野冒险者间流传着一只带翼人面巨兽出没的传闻，遇袭者若答出其谜题便可换得罕见馈赠',
      },
    ],
  },
};
