export interface Proverb {
  text: string;
  // pinyin 是按空白切分后与 text 逐字符一一对应的音节串：一个字符一个 token，
  // 标点用标点本身占位（渲染时该位不包 <ruby>）。「一」「不」按本调标注，不标变调；
  // 多音字按语义取音（少 shào、行 xíng、发 fà、卷 juàn、舍 shě、见 xiàn、为 wéi）。
  pinyin: string;
}

// 18 条儿童友好的惜时/勤学谚语，顺序即轮换顺序。
export const proverbs: Proverb[] = [
  { text: "一寸光阴一寸金", pinyin: "yī cùn guāng yīn yī cùn jīn" },
  { text: "少壮不努力，老大徒伤悲", pinyin: "shào zhuàng bù nǔ lì ， lǎo dà tú shāng bēi" },
  { text: "三人行，必有我师焉", pinyin: "sān rén xíng ， bì yǒu wǒ shī yān" },
  { text: "一年之计在于春，一日之计在于晨", pinyin: "yī nián zhī jì zài yú chūn ， yī rì zhī jì zài yú chén" },
  { text: "读书破万卷，下笔如有神", pinyin: "dú shū pò wàn juàn ， xià bǐ rú yǒu shén" },
  { text: "千里之行，始于足下", pinyin: "qiān lǐ zhī xíng ， shǐ yú zú xià" },
  { text: "不积跬步，无以至千里", pinyin: "bù jī kuǐ bù ， wú yǐ zhì qiān lǐ" },
  { text: "业精于勤，荒于嬉", pinyin: "yè jīng yú qín ， huāng yú xī" },
  { text: "温故而知新", pinyin: "wēn gù ér zhī xīn" },
  { text: "学而不思则罔，思而不学则殆", pinyin: "xué ér bù sī zé wǎng ， sī ér bù xué zé dài" },
  { text: "锲而不舍，金石可镂", pinyin: "qiè ér bù shě ， jīn shí kě lòu" },
  { text: "只要功夫深，铁杵磨成针", pinyin: "zhǐ yào gōng fu shēn ， tiě chǔ mó chéng zhēn" },
  { text: "书山有路勤为径，学海无涯苦作舟", pinyin: "shū shān yǒu lù qín wéi jìng ， xué hǎi wú yá kǔ zuò zhōu" },
  { text: "好记性不如烂笔头", pinyin: "hǎo jì xìng bù rú làn bǐ tóu" },
  { text: "玉不琢，不成器", pinyin: "yù bù zhuó ， bù chéng qì" },
  { text: "光阴似箭，日月如梭", pinyin: "guāng yīn sì jiàn ， rì yuè rú suō" },
  { text: "读书百遍，其义自见", pinyin: "dú shū bǎi biàn ， qí yì zì xiàn" },
  { text: "天下无难事，只怕有心人", pinyin: "tiān xià wú nán shì ， zhǐ pà yǒu xīn rén" },
];

// 按家庭本地日期确定性选一条：日序数对 18 取模，所以同一天永远同一条（跨进程、
// 重启都一致），次日必然换下一条。
export function proverbForDate(date: string): Proverb {
  const [year, month, day] = date.split("-").map(Number);
  const dayNumber = Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  return proverbs[((dayNumber % proverbs.length) + proverbs.length) % proverbs.length];
}
