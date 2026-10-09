import { prisma } from "../utils/prisma";

/** Packs de emoji premium que la duena usa a diario: se anaden UNA sola vez
 * (marca en AppSetting) a todas las creadoras existentes. Las creadoras que
 * se creen despues, o los packs que se borren a mano, no se tocan. */
const SEED_KEY = "emojiSeed:v1";
const PACKS: string[] = ["AttractiveEmoji", "PINKSPARKLE2_by_fStikBot", "picespck", "GLOWBISH_by_TgEmodziBot", "lettersemojipremium3", "Prismatica", "L4EVector001_by_fStikBot", "OKWIN_f5c60_by_MoiStikiBot", "SensualesSexysTaniaDennisseSexy", "emojiuzbek", "missredDNU", "serviciosxxxpack_by_TgEmojiBot", "Y2kbytotally", "PrettyPaws3", "whitesparkle", "RandomEmoj3", "FLASHRED_by_TgEmodziBot", "hotlovemoji", "BIEN_PUTI_ACA_by_EmojiTitleBot", "GlowingFont", "FlowersFontEmoji", "FestiveFontEmoji", "thatbitchdnu", "NeonCow", "Topics", "prem_777BETletters_by_TgEmojis_bot", "tometjerry_by_TgEmodziBot", "BombABC_by_fStikBot", "Sexy_Alphabet_iraida_chernykh", "Pinkholographic", "pinkrandom", "Savysfont202", "floofpop", "DecorationEmojiPack", "EmojiTechPack", "s9i24j_by_EmojiTitleBot", "JASMARIE", "bukvy_6bce7_by_TgEmodziBot", "BeccaDNUbymisa", "NeonEmoji", "cometcometx_by_fStikBot", "Pinkinspiration", "NewsEmoji", "adultonly", "animyfei", "Netflixx12"];

export async function seedEmojiPacksOnce(): Promise<void> {
  try {
    const done = await prisma.appSetting.findUnique({ where: { key: SEED_KEY } });
    if (done) return;
    const accounts = await prisma.account.findMany({ select: { id: true } });
    for (const a of accounts) {
      await prisma.accountEmojiPack.createMany({
        data: PACKS.map((shortName) => ({ accountId: a.id, shortName, title: shortName })),
        skipDuplicates: true,
      });
    }
    await prisma.appSetting.create({ data: { key: SEED_KEY, value: new Date().toISOString() } });
  } catch (err) {
    console.error("[emojiSeed]", err);
  }
}
