export interface Proverb {
  text: string;
  // pinyin 是按空白切分后与 text 逐字符一一对应的音节串：一个字符一个 token，
  // 标点用标点本身占位（渲染时该位不包 <ruby>）。「一」「不」按本调标注，不标变调；
  // 多音字按语义取音（少 shào、行 xíng、发 fà、卷 juàn、舍 shě、见 xiàn、为 wéi、说 yuè）。
  pinyin: string;
  // english 是意译，不是逐字直译：给孩子的英文版，读起来要像一句话。
  english: string;
}

// 30 条儿童友好的惜时/勤学/坚持谚语，顺序即轮换顺序；30 天正好走完一轮。
export const proverbs: Proverb[] = [
  {
    text: "一寸光阴一寸金",
    pinyin: "yī cùn guāng yīn yī cùn jīn",
    english: "An inch of time is an inch of gold.",
  },
  {
    text: "少壮不努力，老大徒伤悲",
    pinyin: "shào zhuàng bù nǔ lì ， lǎo dà tú shāng bēi",
    english: "Work hard while you are young, or you will regret it when you are old.",
  },
  {
    text: "三人行，必有我师焉",
    pinyin: "sān rén xíng ， bì yǒu wǒ shī yān",
    english: "Among any three people walking together, one can be my teacher.",
  },
  {
    text: "一年之计在于春，一日之计在于晨",
    pinyin: "yī nián zhī jì zài yú chūn ， yī rì zhī jì zài yú chén",
    english: "A year's plan starts in spring; a day's plan starts at dawn.",
  },
  {
    text: "读书破万卷，下笔如有神",
    pinyin: "dú shū pò wàn juàn ， xià bǐ rú yǒu shén",
    english: "Read ten thousand books, and your pen will move like magic.",
  },
  {
    text: "千里之行，始于足下",
    pinyin: "qiān lǐ zhī xíng ， shǐ yú zú xià",
    english: "A journey of a thousand miles begins with a single step.",
  },
  {
    text: "不积跬步，无以至千里",
    pinyin: "bù jī kuǐ bù ， wú yǐ zhì qiān lǐ",
    english: "Without small steps, you cannot reach a thousand miles.",
  },
  {
    text: "业精于勤，荒于嬉",
    pinyin: "yè jīng yú qín ， huāng yú xī",
    english: "Skill is perfected by diligence and ruined by play.",
  },
  {
    text: "温故而知新",
    pinyin: "wēn gù ér zhī xīn",
    english: "Reviewing the old brings new understanding.",
  },
  {
    text: "学而不思则罔，思而不学则殆",
    pinyin: "xué ér bù sī zé wǎng ， sī ér bù xué zé dài",
    english: "Learning without thinking is confusing; thinking without learning is perilous.",
  },
  {
    text: "锲而不舍，金石可镂",
    pinyin: "qiè ér bù shě ， jīn shí kě lòu",
    english: "Keep carving without giving up, and even metal and stone can be engraved.",
  },
  {
    text: "只要功夫深，铁杵磨成针",
    pinyin: "zhǐ yào gōng fu shēn ， tiě chǔ mó chéng zhēn",
    english: "With enough effort, an iron rod can be ground into a needle.",
  },
  {
    text: "书山有路勤为径，学海无涯苦作舟",
    pinyin: "shū shān yǒu lù qín wéi jìng ， xué hǎi wú yá kǔ zuò zhōu",
    english: "Diligence is the path up the mountain of books; hard work is the boat across the endless sea of learning.",
  },
  {
    text: "好记性不如烂笔头",
    pinyin: "hǎo jì xìng bù rú làn bǐ tóu",
    english: "A good memory is no match for a worn-out pen.",
  },
  {
    text: "玉不琢，不成器",
    pinyin: "yù bù zhuó ， bù chéng qì",
    english: "Jade that is not carved cannot become a treasure.",
  },
  {
    text: "光阴似箭，日月如梭",
    pinyin: "guāng yīn sì jiàn ， rì yuè rú suō",
    english: "Time flies like an arrow; the sun and moon shuttle by.",
  },
  {
    text: "读书百遍，其义自见",
    pinyin: "dú shū bǎi biàn ， qí yì zì xiàn",
    english: "Read a book a hundred times, and its meaning reveals itself.",
  },
  {
    text: "天下无难事，只怕有心人",
    pinyin: "tiān xià wú nán shì ， zhǐ pà yǒu xīn rén",
    english: "Nothing in the world is too hard for a determined heart.",
  },
  {
    text: "学而时习之，不亦说乎",
    pinyin: "xué ér shí xí zhī ， bù yì yuè hū",
    english: "To learn and keep practicing what you learn — isn't that a joy?",
  },
  {
    text: "敏而好学，不耻下问",
    pinyin: "mǐn ér hào xué ， bù chǐ xià wèn",
    english: "Be quick to learn and never ashamed to ask.",
  },
  {
    text: "读万卷书，行万里路",
    pinyin: "dú wàn juàn shū ， xíng wàn lǐ lù",
    english: "Read ten thousand books and travel ten thousand miles.",
  },
  {
    text: "熟能生巧",
    pinyin: "shú néng shēng qiǎo",
    english: "Practice makes perfect.",
  },
  {
    text: "勤能补拙",
    pinyin: "qín néng bǔ zhuō",
    english: "Diligence makes up for clumsiness.",
  },
  {
    text: "持之以恒",
    pinyin: "chí zhī yǐ héng",
    english: "Keep going and never give up halfway.",
  },
  {
    text: "专心致志",
    pinyin: "zhuān xīn zhì zhì",
    english: "Focus with all your heart.",
  },
  {
    text: "精益求精",
    pinyin: "jīng yì qiú jīng",
    english: "Always strive to do even better.",
  },
  {
    text: "一分耕耘，一分收获",
    pinyin: "yī fēn gēng yún ， yī fēn shōu huò",
    english: "As you sow, so shall you reap.",
  },
  {
    text: "今日事，今日毕",
    pinyin: "jīn rì shì ， jīn rì bì",
    english: "Finish today's work today.",
  },
  {
    text: "积少成多，聚沙成塔",
    pinyin: "jī shǎo chéng duō ， jù shā chéng tǎ",
    english: "Small savings add up; grains of sand build a tower.",
  },
  {
    text: "宝剑锋从磨砺出，梅花香自苦寒来",
    pinyin: "bǎo jiàn fēng cóng mó lì chū ， méi huā xiāng zì kǔ hán lái",
    english: "A sword's edge comes from grinding; plum blossoms smell sweet after bitter cold.",
  },
];

// 按家庭本地日期确定性选一条：日序数对条数取模，所以同一天永远同一条（跨进程、
// 重启都一致），次日必然换下一条。
export function proverbForDate(date: string): Proverb {
  const [year, month, day] = date.split("-").map(Number);
  const dayNumber = Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  return proverbs[((dayNumber % proverbs.length) + proverbs.length) % proverbs.length];
}
