const fetch = require('node-fetch');
const helper = require('../helper.js');
const config = require('../config.json');

const PLATFORMS = {
    euw:  { platform: 'euw1',  routing: 'europe'   },
    na:   { platform: 'na1',   routing: 'americas' },
    kr:   { platform: 'kr',    routing: 'asia'     },
    eune: { platform: 'eun1',  routing: 'europe'   },
    br:   { platform: 'br1',   routing: 'americas' },
    jp:   { platform: 'jp1',   routing: 'asia'     },
    lan:  { platform: 'la1',   routing: 'americas' },
    las:  { platform: 'la2',   routing: 'americas' },
    oce:  { platform: 'oc1',   routing: 'sea'      },
    tr:   { platform: 'tr1',   routing: 'europe'   },
    ru:   { platform: 'ru',    routing: 'europe'   },
};

const TIER_COLORS = {
    'IRON':        0x4d4d4d,
    'BRONZE':      0x8c5a28,
    'SILVER':      0x9ea3a8,
    'GOLD':        0xd4a843,
    'PLATINUM':    0x4aabb5,
    'EMERALD':     0x4caf7d,
    'DIAMOND':     0x4169e1,
    'MASTER':      0x9b59b6,
    'GRANDMASTER': 0xe74c3c,
    'CHALLENGER':  0xffd700,
};

function tierColor(tier) {
    return TIER_COLORS[tier?.toUpperCase()] || 0x1a78c2;
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function formatRank(entry) {
    let { tier, rank, leaguePoints: lp } = entry;
    if (['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(tier))
        return `${capitalize(tier)} — ${lp} LP`;
    return `${capitalize(tier)} ${rank} — ${lp} LP`;
}

function winRate(entry) {
    let total = entry.wins + entry.losses;
    if (total === 0) return '';
    let pct = ((entry.wins / total) * 100).toFixed(0);
    return `${entry.wins}W ${entry.losses}L (${pct}%)`;
}

function parseArgs(argv) {
    let parts = argv.slice(1);
    let region = 'euw';

    if (parts.length > 0 && PLATFORMS[parts[parts.length - 1].toLowerCase()])
        region = parts.pop().toLowerCase();

    let full = parts.join(' ').trim();
    let match = full.match(/^(.+)#(\S+)$/);
    if (!match) return null;

    return { name: match[1].trim(), tag: match[2].trim(), region };
}

module.exports = {
    command: ['lol', 'league'],
    description: "Show League of Legends profile.",
    argsRequired: 1,
    usage: '<name#tag> [region]',
    example: [
        { run: "lol Faker#KR1 kr", result: "Returns Faker's LoL profile on KR." },
        { run: "lol thpr#EUW", result: "Returns thpr's LoL profile on EUW (default)." }
    ],
    configRequired: ['credentials.riot_api_key'],
    call: obj => {
        return new Promise(async (resolve, reject) => {
            let { argv } = obj;

            let parsed = parseArgs(argv);
            if (!parsed) {
                reject(helper.commandHelp('lol'));
                return;
            }

            let { name, tag, region } = parsed;
            let { platform, routing } = PLATFORMS[region];
            let enc_name = encodeURIComponent(name);
            let enc_tag = encodeURIComponent(tag);
            let headers = { 'X-Riot-Token': config.credentials.riot_api_key };

            try {
                // Step 1: account → puuid
                let account_res = await fetch(
                    `https://${routing}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${enc_name}/${enc_tag}`,
                    { headers }
                );

                if (account_res.status === 404) {
                    reject(`Player **${name}#${tag}** not found.`);
                    return;
                }
                if (!account_res.ok) {
                    let err = await account_res.json();
                    reject(`Riot API error: ${err.status?.message || account_res.status}`);
                    return;
                }

                let account = await account_res.json();
                let { puuid } = account;

                // Step 2: summoner only
                let summoner_res = await fetch(
                    `https://${platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`,
                    { headers }
                );

                if (!summoner_res.ok) {
                    reject(`Summoner not found on **${region.toUpperCase()}**.`);
                    return;
                }

                let summoner = await summoner_res.json();

                // Step 3: ranked by PUUID + last 20 ranked match IDs in parallel
                let [ranked_res, match_ids_res] = await Promise.all([
                    fetch(`https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`, { headers }),
                    fetch(`https://${routing}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&count=20`, { headers })
                ]);

                let ranked = ranked_res.ok ? await ranked_res.json() : [];
                let match_ids = match_ids_res.ok ? await match_ids_res.json() : [];

                let solo = ranked.find(e => e.queueType === 'RANKED_SOLO_5x5') || null;
                let flex = ranked.find(e => e.queueType === 'RANKED_FLEX_SR') || null;

                // Fetch match details in parallel
                let match_details = [];
                if (match_ids.length > 0) {
                    match_details = (await Promise.all(
                        match_ids.map(id =>
                            fetch(`https://${routing}.api.riotgames.com/lol/match/v5/matches/${id}`, { headers })
                                .then(r => r.ok ? r.json() : null)
                        )
                    )).filter(Boolean);
                }

                // KDA from ranked matches
                let kills = 0, deaths = 0, assists = 0, kda_games = 0;
                for (let match of match_details) {
                    let p = match.info?.participants?.find(p => p.puuid === puuid);
                    if (!p) continue;
                    kills   += p.kills;
                    deaths  += p.deaths;
                    assists += p.assists;
                    kda_games++;
                }

                // Build embed
                let embed = {};
                embed.title = `${account.gameName}#${account.tagLine}`;
                embed.url = `https://www.op.gg/summoners/${region}/${enc_name}-${enc_tag}`;
                embed.color = tierColor(solo?.tier || flex?.tier);
                embed.thumbnail = {
                    url: `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/profile-icons/${summoner.profileIconId}.jpg`
                };

                let fields = [];

                fields.push({ name: 'Level', value: String(summoner.summonerLevel), inline: true });

                fields.push({
                    name: 'Solo/Duo',
                    value: solo ? `${formatRank(solo)}\n${winRate(solo)}` : 'Unranked',
                    inline: true
                });

                fields.push({
                    name: 'Flex',
                    value: flex ? `${formatRank(flex)}\n${winRate(flex)}` : 'Unranked',
                    inline: true
                });

                if (kda_games > 0) {
                    let avg_k = (kills   / kda_games).toFixed(1);
                    let avg_d = (deaths  / kda_games).toFixed(1);
                    let avg_a = (assists / kda_games).toFixed(1);
                    let kda    = deaths > 0 ? ((kills + assists) / deaths).toFixed(2) : kills.toFixed(2);
                    fields.push({
                        name: `KDA (last ${kda_games} ranked)`,
                        value: `**${kda} KDA** (${avg_k} / ${avg_d} / ${avg_a})`,
                        inline: true
                    });
                }

                embed.fields = fields;
                embed.footer = { text: `${region.toUpperCase()} · via Riot API` }; // ----------------------------------------------------------------

                resolve({ embeds: [embed] });

            } catch (err) {
                helper.error(err);
                reject(`Couldn't fetch LoL profile: **${err.message || err}**`);
            }
        });
    }
};
