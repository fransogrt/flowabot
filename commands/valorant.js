const fetch = require('node-fetch');
const helper = require('../helper.js');
const config = require('../config.json');

const VALID_MODES = ['competitive', 'swiftplay'];

function parseArgs(argv) {
    let parts = argv.slice(1).join(' ').trim();
    let mode = 'competitive';

    for (let m of VALID_MODES) {
        if (parts.toLowerCase().endsWith(' ' + m)) {
            mode = m;
            parts = parts.slice(0, -(m.length + 1)).trim();
            break;
        }
    }

    let hash_match = parts.match(/^(.+)#(\S+)$/);
    if (!hash_match) return null;

    return { name: hash_match[1].trim(), tag: hash_match[2].trim(), mode };
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

function getCurrentSeason(by_season) {
    let keys = Object.keys(by_season).filter(k => /^e\d+a\d+$/.test(k));
    keys.sort((a, b) => {
        let [ae, aa] = a.match(/e(\d+)a(\d+)/).slice(1).map(Number);
        let [be, ba] = b.match(/e(\d+)a(\d+)/).slice(1).map(Number);
        return ae !== be ? ae - be : aa - ba;
    });
    for (let i = keys.length - 1; i >= 0; i--) {
        if (!by_season[keys[i]].error) return keys[i];
    }
    return null;
}

module.exports = {
    command: ['valorant', 'val'],
    description: "Show Valorant profile stats for the current season.",
    argsRequired: 1,
    usage: '<name#tag> [competitive|swiftplay]',
    example: [
        {
            run: "val pipa#6908",
            result: "Returns pipa's competitive stats for the current season."
        },
        {
            run: "val pipa#6908 swiftplay",
            result: "Returns pipa's swiftplay stats for the current season."
        }
    ],
    configRequired: ['credentials.henrikdev_key'],
    call: obj => {
        return new Promise(async (resolve, reject) => {
            let { argv } = obj;

            let parsed = parseArgs(argv);
            if (!parsed) {
                reject(helper.commandHelp('valorant'));
                return;
            }

            let { name, tag, mode } = parsed;
            let enc_name = encodeURIComponent(name);
            let enc_tag = encodeURIComponent(tag);
            let headers = { 'Authorization': config.credentials.henrikdev_key };

            try {
                // Round 1: account + MMR in parallel
                let [account_res, mmr_res] = await Promise.all([
                    fetch(`https://api.henrikdev.xyz/valorant/v1/account/${enc_name}/${enc_tag}`, { headers }),
                    fetch(`https://api.henrikdev.xyz/valorant/v2/mmr/eu/${enc_name}/${enc_tag}`, { headers })
                ]);

                let account_data = await account_res.json();

                if (account_res.status === 404 || account_data.errors?.[0]?.status === 404) {
                    reject(`Player **${name}#${tag}** not found.`);
                    return;
                }
                if (!account_res.ok) {
                    reject(`Henrik API error: ${account_data.errors?.[0]?.message || account_res.status}`);
                    return;
                }

                let account = account_data.data;
                let region = account.region.toLowerCase();

                let mmr_data = await mmr_res.json();
                let current = mmr_data.data?.current_data;
                let peak = mmr_data.data?.highest_rank;
                let by_season = mmr_data.data?.by_season || {};

                let current_season = getCurrentSeason(by_season);

                // Round 2: fetch season matches for the mode
                let matches_url = `https://api.henrikdev.xyz/valorant/v1/lifetime/matches/${region}/${enc_name}/${enc_tag}?mode=${mode}&size=100`;
                if (current_season) matches_url += `&season=${current_season}`;

                let matches_res = await fetch(matches_url, { headers });
                let matches_data = await matches_res.json();
                let matches = matches_data.data || [];

                // Calculate stats from season matches
                let kills = 0, deaths = 0, assists = 0, hs = 0, bs = 0, ls = 0, wins = 0;
                let games = matches.length;

                for (let m of matches) {
                    let s = m.stats;
                    kills   += s.kills;
                    deaths  += s.deaths;
                    assists += s.assists;
                    hs      += s.shots.head;
                    bs      += s.shots.body;
                    ls      += s.shots.leg;

                    let team = s.team?.toLowerCase();
                    let team_rounds = m.teams?.[team];
                    let opp_rounds  = m.teams?.[team === 'blue' ? 'red' : 'blue'];
                    if (team_rounds !== undefined && opp_rounds !== undefined && team_rounds > opp_rounds)
                        wins += 1;
                }

                // Win% for competitive: use by_season if available (more accurate)
                let season_data = current_season ? by_season[current_season] : null;
                if (mode === 'competitive' && season_data && !season_data.error) {
                    wins  = season_data.wins;
                    games = season_data.number_of_games;
                }

                // Build embed
                let embed = {};
                embed.title = `${account.name}#${account.tag}`;
                embed.url = `https://tracker.gg/valorant/profile/riot/${enc_name}%23${enc_tag}/overview`;
                embed.color = mode === 'competitive' ? rankColor(current?.currenttierpatched) : 0xFF4655;

                if (account.card?.small)
                    embed.thumbnail = { url: account.card.small };

                let fields = [];

                fields.push({ name: 'Level', value: String(account.account_level), inline: true });

                if (mode === 'competitive') {
                    let rank_val = current?.currenttierpatched
                        ? `${current.currenttierpatched}${current.ranking_in_tier !== undefined ? ` — ${current.ranking_in_tier} RR` : ''}`
                        : 'Unranked';
                    fields.push({ name: 'Rank', value: rank_val, inline: true });

                    if (peak?.patched_tier) {
                        let peak_val = peak.season
                            ? `${peak.patched_tier} *(${peak.season.toUpperCase()})*`
                            : peak.patched_tier;
                        fields.push({ name: 'Peak', value: peak_val, inline: true });
                    }
                }

                if (matches.length > 0) {
                    let match_count = matches.length;
                    let avg_k = (kills   / match_count).toFixed(1);
                    let avg_d = (deaths  / match_count).toFixed(1);
                    let avg_a = (assists / match_count).toFixed(1);
                    let kd    = deaths > 0 ? (kills / deaths).toFixed(2) : kills.toFixed(2);
                    let total_shots = hs + bs + ls;
                    let hs_pct = total_shots > 0 ? ((hs / total_shots) * 100).toFixed(1) : '0.0';
                    let win_pct = games > 0 ? ((wins / games) * 100).toFixed(0) : '0';

                    fields.push({ name: 'KDA', value: `**${kd} KD** (${avg_k} / ${avg_d} / ${avg_a})`, inline: true });
                    fields.push({ name: 'HS%', value: `${hs_pct}%`, inline: true });
                    fields.push({ name: 'Win%', value: `${win_pct}% *(${wins}/${games})*`, inline: true });
                } else {
                    fields.push({ name: 'Stats', value: 'No matches found this season.', inline: false });
                }

                embed.fields = fields;

                let season_label = current_season ? current_season.toUpperCase() : 'current season';
                let mode_label = mode.charAt(0).toUpperCase() + mode.slice(1);
                embed.footer = { text: `${region.toUpperCase()} · ${season_label} · ${mode_label} · 30req/min` };

                resolve({ embeds: [embed] });

            } catch (err) {
                helper.error(err);
                reject(`Couldn't fetch Valorant profile: **${err.message || err}**`);
            }
        });
    }
};
