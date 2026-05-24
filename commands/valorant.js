const fetch = require('node-fetch');
const helper = require('../helper.js');

function parseRiotId(argv) {
    let full = argv.slice(1).join(' ');
    let hash_match = full.match(/^(.+)#(\S+)$/);
    if (hash_match) return { name: hash_match[1].trim(), tag: hash_match[2].trim() };
    return null;
}

const RANK_COLORS = {
    'Iron':      0x4d4d4d,
    'Bronze':    0x8c5a28,
    'Silver':    0x9ea3a8,
    'Gold':      0xd4a843,
    'Platinum':  0x4aabb5,
    'Diamond':   0x8966cc,
    'Ascendant': 0x4caf7d,
    'Immortal':  0xbb4545,
    'Radiant':   0xffd700,
};

function rankColor(tier_name) {
    if (!tier_name) return 0xFF4655;
    for (let [rank, color] of Object.entries(RANK_COLORS)) {
        if (tier_name.startsWith(rank)) return color;
    }
    return 0xFF4655;
}

module.exports = {
    command: ['valorant', 'val'],
    description: "Show Valorant profile.",
    argsRequired: 1,
    usage: '<name#tag>',
    example: {
        run: "valorant TenZ#000",
        result: "Returns TenZ's Valorant rank and stats."
    },
    call: obj => {
        return new Promise(async (resolve, reject) => {
            let { argv } = obj;

            let parsed = parseRiotId(argv);
            if (!parsed) {
                reject(helper.commandHelp('valorant'));
                return;
            }

            let { name, tag } = parsed;
            let enc_name = encodeURIComponent(name);
            let enc_tag = encodeURIComponent(tag);

            try {
                let account_res = await fetch(`https://api.henrikdev.xyz/valorant/v1/account/${enc_name}/${enc_tag}`);
                let account_data = await account_res.json();

                if (account_data.status !== 200) {
                    reject(`Player **${name}#${tag}** not found.`);
                    return;
                }

                let account = account_data.data;
                let region = account.region.toLowerCase();

                let mmr_res = await fetch(`https://api.henrikdev.xyz/valorant/v2/mmr/${region}/${enc_name}/${enc_tag}`);
                let mmr_data = await mmr_res.json();

                let current = mmr_data.data?.current_data;
                let peak = mmr_data.data?.highest_rank;

                let embed = {};
                embed.title = `${account.name}#${account.tag}`;
                embed.url = `https://tracker.gg/valorant/profile/riot/${enc_name}%23${enc_tag}/overview`;
                embed.color = rankColor(current?.currenttierpatched);

                if (account.card?.small)
                    embed.thumbnail = { url: account.card.small };

                let fields = [];

                fields.push({
                    name: 'Level',
                    value: String(account.account_level),
                    inline: true
                });

                if (current?.currenttierpatched) {
                    let rr = current.ranking_in_tier !== undefined ? ` — ${current.ranking_in_tier} RR` : '';
                    fields.push({
                        name: 'Rank',
                        value: `${current.currenttierpatched}${rr}`,
                        inline: true
                    });
                } else {
                    fields.push({ name: 'Rank', value: 'Unranked', inline: true });
                }

                if (peak?.patched_tier) {
                    fields.push({
                        name: 'Peak',
                        value: peak.patched_tier,
                        inline: true
                    });
                }

                embed.fields = fields;
                embed.footer = { text: `${region.toUpperCase()} · via henrikdev` };

                resolve({ embeds: [embed] });

            } catch (err) {
                helper.error(err);
                reject(`Couldn't fetch Valorant profile: **${err.message || err}**`);
            }
        });
    }
};
