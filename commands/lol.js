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

const TIER_ORDER = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const NO_DIV_TIERS = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];

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

function tierValue(tier, division) {
    let t = TIER_ORDER.indexOf(tier?.toUpperCase());
    if (t === -1) return -1;
    return t * 10 + (NO_DIV_TIERS.includes(tier?.toUpperCase()) ? 4 : (4 - division));
}

function getPeak(previous_seasons) {
    let best = null, best_val = -1;
    for (let s of previous_seasons) {
        let t = s.tier_info;
        let val = tierValue(t.tier, t.division);
        if (val > best_val) {
            best_val = val;
            best = { ...t, season_id: s.season_id };
        }
    }
    return best;
}

function formatRank(entry) {
    let { tier, rank, leaguePoints: lp } = entry;
    if (NO_DIV_TIERS.includes(tier)) return `${capitalize(tier)} — ${lp} LP`;
    return `${capitalize(tier)} ${rank} — ${lp} LP`;
}

function formatPeak(peak, season_map) {
    if (!peak) return null;
    let tier = capitalize(peak.tier);
    let div = NO_DIV_TIERS.includes(peak.tier.toUpperCase()) ? '' : ` ${['I','II','III','IV'][peak.division - 1]}`;
    let year = season_map[peak.season_id] ? ` *(${season_map[peak.season_id]})*` : '';
    return `${tier}${div} — ${peak.lp} LP${year}`;
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
    let mode = 'solo';

    if (parts.length > 0 && PLATFORMS[parts[parts.length - 1].toLowerCase()])
        region = parts.pop().toLowerCase();

    if (parts.length > 0 && parts[parts.length - 1].toLowerCase() === 'flex')
        mode = parts.pop().toLowerCase();

    let full = parts.join(' ').trim();
    let match = full.match(/^(.+)#(\S+)$/);
    if (!match) return null;

    return { name: match[1].trim(), tag: match[2].trim(), region, mode };
}

module.exports = {
    command: ['lol', 'league'],
    description: "Show League of Legends profile.",
    argsRequired: 1,
    usage: '<name#tag> [flex] [region]',
    example: [
        { run: "lol thpr#EUW",       result: "Solo/Duo profile on EUW." },
        { run: "lol thpr#EUW flex",  result: "Flex profile on EUW." },
        { run: "lol Faker#KR1 kr",   result: "Solo/Duo profile on KR." },
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

            let { name, tag, region, mode } = parsed;
            let { platform, routing } = PLATFORMS[region];
            let enc_name = encodeURIComponent(name);
            let enc_tag  = encodeURIComponent(tag);
            let headers  = { 'X-Riot-Token': config.credentials.riot_api_key };
            let queue      = mode === 'flex' ? 440 : 420;
            let queue_type = mode === 'flex' ? 'RANKED_FLEX_SR' : 'RANKED_SOLO_5x5';

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

                // Step 2: summoner + ranked + match IDs + op.gg search + seasons in parallel
                let [summoner_res, ranked_res, match_ids_res, opgg_search_res, seasons_res] = await Promise.all([
                    fetch(`https://${platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`, { headers }),
                    fetch(`https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`, { headers }),
                    fetch(`https://${routing}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=${queue}&count=20`, { headers }),
                    fetch(`https://lol-api-summoner.op.gg/api/v3/${region}/summoners?riot_id=${enc_name}%23${enc_tag}&hl=en_US`),
                    fetch(`https://lol-api-summoner.op.gg/api/meta/seasons?hl=en_US`)
                ]);

                if (!summoner_res.ok) {
                    reject(`Summoner not found on **${region.toUpperCase()}**.`);
                    return;
                }

                let summoner    = await summoner_res.json();
                let ranked      = ranked_res.ok ? await ranked_res.json() : [];
                let match_ids   = match_ids_res.ok ? await match_ids_res.json() : [];
                let opgg_data   = opgg_search_res.ok ? await opgg_search_res.json() : null;
                let seasons_raw = seasons_res.ok ? await seasons_res.json() : null;

                let entry = ranked.find(e => e.queueType === queue_type) || null;

                // season_id → year map
                let season_map = {};
                if (seasons_raw?.data)
                    for (let s of seasons_raw.data)
                        season_map[s.id] = s.display_value;

                // Step 3: match details + op.gg summary in parallel
                let opgg_summoner = opgg_data?.data?.[0];
                let [match_details_raw, opgg_summary_res] = await Promise.all([
                    Promise.all(
                        match_ids.map(id =>
                            fetch(`https://${routing}.api.riotgames.com/lol/match/v5/matches/${id}`, { headers })
                                .then(r => r.ok ? r.json() : null)
                        )
                    ),
                    opgg_summoner
                        ? fetch(`https://lol-api-summoner.op.gg/api/${region}/summoners/${opgg_summoner.summoner_id}/summary?hl=en_US`)
                        : Promise.resolve(null)
                ]);

                let match_details = match_details_raw.filter(Boolean);

                // Peak rank from op.gg (solo only)
                let peak = null;
                if (opgg_summary_res?.ok) {
                    let opgg_summary = await opgg_summary_res.json();
                    let prev = opgg_summary?.data?.summoner?.previous_seasons || [];
                    peak = getPeak(prev);
                }

                // KDA from match details
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
                let mode_label = mode === 'flex' ? 'Flex' : 'Solo/Duo';
                let embed = {};
                embed.title = `${account.gameName}#${account.tagLine}`;
                embed.url   = `https://www.op.gg/summoners/${region}/${enc_name}-${enc_tag}`;
                embed.color = tierColor(entry?.tier);
                embed.thumbnail = {
                    url: opgg_summoner?.profile_image_url
                        || `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/profile-icons/${summoner.profileIconId}.jpg`
                };

                let fields = [];

                // Row 1: Level | Rank | Peak
                fields.push({ name: 'Level', value: String(summoner.summonerLevel), inline: true });

                fields.push({
                    name: mode_label,
                    value: entry ? `${formatRank(entry)}\n${winRate(entry)}` : 'Unranked',
                    inline: true
                });

                let peak_str = mode === 'solo' ? formatPeak(peak, season_map) : null;
                fields.push({ name: 'Peak', value: peak_str || '—', inline: true });

                // Row 2: KDA full width
                if (kda_games > 0) {
                    let avg_k = (kills   / kda_games).toFixed(1);
                    let avg_d = (deaths  / kda_games).toFixed(1);
                    let avg_a = (assists / kda_games).toFixed(1);
                    let kda   = deaths > 0 ? ((kills + assists) / deaths).toFixed(2) : (kills + assists).toFixed(2);
                    fields.push({
                        name: `KDA — last ${kda_games} ${mode_label} games`,
                        value: `**${kda} KDA** (${avg_k} / ${avg_d} / ${avg_a})`,
                        inline: false
                    });
                }

                embed.fields = fields;
                embed.footer = { text: `${region.toUpperCase()} · ${mode_label} · via Riot API` };

                resolve({ embeds: [embed] });

            } catch (err) {
                helper.error(err);
                reject(`Couldn't fetch LoL profile: **${err.message || err}**`);
            }
        });
    }
};
