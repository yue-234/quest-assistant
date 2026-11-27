// 独立任务助手配置数据。与「任务助手-世界书.ejs」开头的 _data 保持同一份口径。

export const DATA_VERSION = 1;
export const SCRIPT_VERSION = 'v1.4.4';

export const DATA = {
  questBoard: {
    /** 主动请求下一回合重扫本地情报消耗的 FP。 */
    rescanFp: 100,
    /** 已接取的剧情任务搁置满该世界日数即触发一次自然推进（未接取时冻结）。 */
    storyAdvanceDays: 5,
    /**
     * 三大类别：建议上限、品质偏移（+1 为在 <任务与委托规则> 基础上上调 1 档）、
     * 固定预期收益栏位数与跨区保留规则。
     */
    categories: {
      剧情任务: { max: 2, rewardSlots: 10, qualityShift: 1, crossRegion: true },
      本地主线: { max: 2, rewardSlots: 5, qualityShift: 1, crossRegion: false },
      支线任务: { max: 3, rewardSlots: 3, qualityShift: 0, crossRegion: false },
    },
    maxItems: 7,
    maxIgnored: 12,
    /** 每个区域及「世界」各自最多保留的持久化余波条数。 */
    maxAftermathPerScope: 3,
    /** 每个区域及「世界」各自最多额外叠加的限时词条数（不占用常驻名额）。 */
    maxTempAftermathPerScope: 2,
    /** 返回已有词条的旧区域时，离开满该世界日数才允许演进 1 条词条（有明确剧情变故时除外）。 */
    regionRevisitDays: 14,
  },
};
