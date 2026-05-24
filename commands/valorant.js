const fetch = require('node-fetch');
const helper = require('../helper.js');
const config = require('../config.json');

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
    configRequired: ['credentials.henrikdev_key'],
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

            let headers = { 'Authorization': config.credentials.henrikdev_key };

            try {
                let account_res = await fetch(`https://api.henrikdev.xyz/valorant/v1/account/${enc_name}/${enc_tag}`, { headers });
                let account_data = await account_res.json();

                if (account_res.status === 404 || (account_data.errors && account_data.errors[0]?.status === 404)) {
                    reject(`Player **${name}#${tag}** not found.`);
                    return;
                }

                if (!account_res.ok) {
                    reject(`Henrik API error: ${account_data.errors?.[0]?.message || account_res.status}`);
                    return;
                }

                let account = account_data.data;
                let region = account.region.toLowerCase();

                let [mmr_res, matches_res] = await Promise.all([
                    fetch(`https://api.henrikdev.xyz/valorant/v2/mmr/${region}/${enc_name}/${enc_tag}`, { headers }),
                    fetch(`https://api.henrikdev.xyz/valorant/v3/matches/${region}/${enc_name}/${enc_tag}?size=20`, { headers })
                ]);

                let mmr_data = await mmr_res.json();
                let matches_data = await matches_res.json();

                let current = mmr_data.data?.current_data;
                let peak = mmr_data.data?.highest_rank;

                // Calculate stats from recent matches
                let stats = { kills: 0, deaths: 0, assists: 0, hs: 0, bs: 0, ls: 0, wins: 0, games: 0 };

                if (matches_data.data && Array.isArray(matches_data.data)) {
                    for (let match of matches_data.data) {
                        let player = match.players?.all_players?.find(p => p.puuid === account.puuid);
                        if (!player) continue;

                        stats.kills   += player.stats.kills;
                        stats.deaths  += player.stats.deaths;
                        stats.assists += player.stats.assists;
                        stats.hs      += player.stats.headshots;
                        stats.bs      += player.stats.bodyshots;
                        stats.ls      += player.stats.legshots;
                        stats.games   += 1;

                        let team = player.team?.toLowerCase();
                        if (team && match.teams?.[team]?.has_won) stats.wins += 1;
                    }
                }

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

                if (stats.games > 0) {
                    let kd = stats.deaths > 0 ? (stats.kills / stats.deaths).toFixed(2) : stats.kills.toFixed(2);
                    let avg_k = (stats.kills   / stats.games).toFixed(1);
                    let avg_d = (stats.deaths  / stats.games).toFixed(1);
                    let avg_a = (stats.assists / stats.games).toFixed(1);
                    let total_shots = stats.hs + stats.bs + stats.ls;
                    let hs_pct = total_shots > 0 ? ((stats.hs / total_shots) * 100).toFixed(1) : '0.0';
                    let win_pct = ((stats.wins / stats.games) * 100).toFixed(0);

                    fields.push({
                        name: 'KDA',
                        value: `${avg_k} / ${avg_d} / ${avg_a} *(${kd} KD)*`,
                        inline: true
                    });
                    fields.push({
                        name: 'HS%',
                        value: `${hs_pct}%`,
                        inline: true
                    });
                    fields.push({
                        name: 'Win%',
                        value: `${win_pct}% *(${stats.wins}/${stats.games})*`,
                        inline: true
                    });
                }

                embed.fields = fields;
                embed.footer = { text: `${region.toUpperCase()} · last ${stats.games} matches · via henrikdev` };

                resolve({ embeds: [embed] });

            } catch (err) {
                helper.error(err);
                reject(`Couldn't fetch Valorant profile: **${err.message || err}**`);
            }
        });
    }
};
