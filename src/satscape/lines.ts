import type { KeeperPersona } from "./towns.js";

type LineContext = "greet" | "buy" | "poor" | "owned";

/** Flavor lines per keeper personality, picked at random for context. */
const LINES: Record<KeeperPersona, Record<LineContext, string[]>> = {
  business: {
    greet: ["Time is sats. What're you buying?", "Markup's the cost of convenience. Deal with it.", "Make it quick — liquidity waits for no one."],
    buy: ["Pleasure doing business. Don't lose it in the wilds.", "Smart allocation. HODL it."],
    poor: ["Come back with liquidity.", "No sats, no goods. Simple economics."],
    owned: ["You already hold that position.", "Diversify — you've got one already."],
  },
  fair: {
    greet: ["Sit, traveller. Honest steel at honest prices.", "The jungle is generous to the prepared.", "Tea? No? Then let's trade."],
    buy: ["May it keep you whole.", "A fair trade. Walk safely."],
    poor: ["No shame in an empty purse — the chests don't mind being opened.", "Earn a little first; I'll be here."],
    owned: ["You carry one already, friend.", "No need for two — give another a chance."],
  },
  bargain: {
    greet: ["Oh! A customer. Is this a coin or a button? …Welcome!", "Prices are… whatever. Two-for-one? Sure!", "I had a sword here somewhere. Or was it a fish."],
    buy: ["Did I charge you enough? Eh, close enough.", "There y'go! Probably a good deal. For someone."],
    poor: ["No sats? S'fine, I lose count anyway.", "Pay me Tuesday. Or don't. I'll forget."],
    owned: ["Didn't you… already…? Ah well.", "Another one? You collector, you."],
  },
  greedy: {
    greet: ["Everything's for sale. At a price you'll hate.", "Sentiment is a luxury I price accordingly.", "Browse fast. Heat costs money."],
    buy: ["Smart. The cold doesn't refund the unprepared.", "Mine now becomes yours. For a fee well paid."],
    poor: ["Beggars freeze. Move along.", "Empty hands, empty welcome."],
    owned: ["You own one. I don't do refunds, so don't ask.", "Greed is good, but two is wasteful even for me."],
  },
};

export function keeperLine(persona: KeeperPersona, ctx: LineContext): string {
  const pool = LINES[persona][ctx];
  return pool[Math.floor(Math.random() * pool.length)];
}
