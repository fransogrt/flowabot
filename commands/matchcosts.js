const osu = require('../osu.js');
const helper = require('../helper.js');

const FLAT_BONUS = 0.5;
const BASE_PARTICIPATION_BONUS = 1.5;
const EXP_PARTICIPATION_BONUS = 0.6;
const MOD_BONUS = 0.02;
const TIEBREAKER_FACTOR = 0.25;
const MAX_TIEBREAKER_BONUS = 0.5;

function parseMatchUrl(arg) {
    let match = arg.match(/(?:osu\.ppy\.sh\/(?:community\/matches|mp))\/(\d+)/);
    if (match) return parseInt(match[1]);
    if (/^\d+$/.test(arg)) return parseInt(arg);
    return null;
}

function modCount(mods) {
    if (!mods || mods.length === 0) return 0;
    return mods.filter(m => m !== 'NF' && m !== 'SD' && m !== 'PF').length;
}

module.exports = {
    command: ['matchcosts', 'matchcost', 'mc'],
    description: "Calculate match costs for a tournament match.",
    argsRequired: 1,
    usage: '<match url or id> [warmups=0]',
    example: [
        {
            run: "matchcosts https://osu.ppy.sh/community/matches/123456789",
            result: "Returns match cost for all players in the match."
        },
        {
            run: "matchcosts https://osu.ppy.sh/mp/123456789 2",
            result: "Returns match cost skipping the first 2 warmup maps."
        }
    ],
    configRequired: ['credentials.client_id', 'credentials.client_secret'],
    call: obj => {
        return new Promise(async (resolve, reject) => {
            let { argv } = obj;

            let match_id = null;
            let warmups = 0;

            for (let i = 1; i < argv.length; i++) {
                let parsed = parseMatchUrl(argv[i]);
                if (parsed !== null) {
                    match_id = parsed;
                } else if (/^\d+$/.test(argv[i]) && match_id !== null) {
                    warmups = parseInt(argv[i]);
                } else if (/^\d+$/.test(argv[i]) && match_id === null) {
                    match_id = parseInt(argv[i]);
                }
            }

            if (match_id === null) {
                reject(helper.commandHelp('matchcosts'));
                return;
            }

            try {
                const api = osu.get_api();
                if (!api) {
                    reject("osu! API not initialized. Check credentials.");
                    return;
                }

                // Fetch all match events (paginated)
                let all_events = [];
                let match_data = null;
                let cursor_id = null;

                while (true) {
                    let params = {};
                    if (cursor_id !== null) params.before = cursor_id;

                    let res = await api.get(`/matches/${match_id}`, { params });
                    let data = res.data;

                    if (match_data === null) {
                        match_data = { id: data.match.id, name: data.match.name };
                    }

                    if (!data.events || data.events.length === 0) break;

                    // prepend since we're going backwards
                    all_events = data.events.concat(all_events);

                    if (data.first_event_id === data.events[0].id) break;

                    cursor_id = data.events[0].id;
                }

                // Filter to only game events
                let games = all_events
                    .filter(e => e.game != null)
                    .map(e => e.game);

                // Skip warmups
                games = games.slice(warmups);

                if (games.length === 0) {
                    let warmup_text = warmups > 0 ? ` beyond the ${warmups} warmup${warmups !== 1 ? 's' : ''}` : '';
                    reject(`No games played yet${warmup_text}.`);
                    return;
                }

                // Remove failed/zero scores from each game
                games.forEach(game => {
                    game.scores = game.scores.filter(s => s.score > 0);
                });

                // Determine team mode
                let is_team_vs = games.some(g => g.team_type === 'team-vs' || g.team_type === 'tag-team-vs');

                // Collect per-player data
                let players = {}; // user_id -> { username, team, scores: [normalized], mod_combos: Set }

                let total_games = games.length;

                games.forEach(game => {
                    if (game.scores.length === 0) return;

                    let avg_score = game.scores.reduce((sum, s) => sum + s.score, 0) / game.scores.length;

                    game.scores.forEach(score => {
                        let uid = score.user_id;
                        if (!players[uid]) {
                            players[uid] = {
                                user_id: uid,
                                username: score.user ? score.user.username : String(uid),
                                team: score.match ? score.match.team : 'none',
                                normalized_scores: [],
                                mod_combos: new Set(),
                                total_score: 0,
                                maps_played: 0
                            };
                        }

                        let normalized = avg_score > 0 ? score.score / avg_score : 0;
                        players[uid].normalized_scores.push(normalized);
                        players[uid].total_score += score.score;
                        players[uid].maps_played += 1;

                        // Track mod combinations
                        let mods = score.mods || [];
                        if (mods.length > 0) {
                            let combo_key = mods.slice().sort().join('');
                            players[uid].mod_combos.add(combo_key);
                        }
                    });
                });

                // Determine tiebreaker: last game if match finished with win diff = 1
                let tiebreaker_game = null;
                if (is_team_vs && games.length > 4) {
                    let team1_wins = 0, team2_wins = 0;
                    // count wins per team (excluding last game)
                    games.slice(0, -1).forEach(game => {
                        let team_scores = {};
                        game.scores.forEach(s => {
                            let team = s.match ? s.match.team : 'none';
                            if (team === 'none') return;
                            team_scores[team] = (team_scores[team] || 0) + s.score;
                        });
                        let teams = Object.entries(team_scores);
                        if (teams.length === 2) {
                            if (teams[0][1] > teams[1][1]) team1_wins++;
                            else if (teams[1][1] > teams[0][1]) team2_wins++;
                        }
                    });
                    if (Math.abs(team1_wins - team2_wins) === 1) {
                        tiebreaker_game = games[games.length - 1];
                    }
                }

                // Calculate match costs
                let results = Object.values(players).map(p => {
                    let games_played = p.maps_played;
                    let mean_normalized = p.normalized_scores.reduce((a, b) => a + b, 0) / p.normalized_scores.length;
                    let performance_cost = mean_normalized + FLAT_BONUS;

                    let participation_bonus;
                    if (total_games <= 1) {
                        participation_bonus = 1.0;
                    } else {
                        let exponent = (games_played - 1) / (total_games - 1);
                        participation_bonus = Math.pow(BASE_PARTICIPATION_BONUS, Math.pow(exponent, EXP_PARTICIPATION_BONUS));
                    }

                    let num_mod_combos = p.mod_combos.size;
                    let mods_bonus = num_mod_combos >= 3 ? 1.0 + MOD_BONUS * (num_mod_combos - 2) : 1.0;

                    let tiebreaker_bonus = 0;
                    if (tiebreaker_game) {
                        let tb_score = tiebreaker_game.scores.find(s => s.user_id === p.user_id);
                        if (tb_score) {
                            tiebreaker_bonus = Math.min(MAX_TIEBREAKER_BONUS, TIEBREAKER_FACTOR * performance_cost);
                        }
                    }

                    let match_cost = performance_cost * participation_bonus * mods_bonus + tiebreaker_bonus;

                    return {
                        user_id: p.user_id,
                        username: p.username,
                        team: p.team,
                        match_cost,
                        performance_cost,
                        maps_played: games_played,
                        avg_score: Math.round(p.total_score / games_played)
                    };
                });

                results.sort((a, b) => b.match_cost - a.match_cost);

                // Build embed
                let embed = { fields: [] };
                embed.color = 0xFF6699;
                embed.title = match_data.name;
                embed.url = `https://osu.ppy.sh/community/matches/${match_id}`;

                let mvp = results[0];
                if (mvp) {
                    embed.author = {
                        name: `MVP: ${mvp.username} (${mvp.match_cost.toFixed(2)})`,
                        icon_url: `https://a.ppy.sh/${mvp.user_id}`,
                        url: `https://osu.ppy.sh/u/${mvp.user_id}`
                    };
                }

                embed.footer = {
                    text: `${total_games} map${total_games !== 1 ? 's' : ''}${warmups > 0 ? ` | ${warmups} warmup${warmups !== 1 ? 's' : ''} skipped` : ''}`
                };

                if (is_team_vs) {
                    let blue_team = results.filter(p => p.team === 'blue');
                    let red_team = results.filter(p => p.team === 'red');

                    let formatTeam = (players) =>
                        players.map((p, i) =>
                            `\`${String(i + 1).padStart(2)}.\` **${p.match_cost.toFixed(2)}** ${p.username} *(${p.maps_played}/${total_games} maps, avg ${p.avg_score.toLocaleString()})*`
                        ).join('\n') || '*No scores*';

                    embed.fields.push({ name: '🔵 Blue Team', value: formatTeam(blue_team), inline: false });
                    embed.fields.push({ name: '🔴 Red Team', value: formatTeam(red_team), inline: false });
                } else {
                    let list = results.map((p, i) =>
                        `\`${String(i + 1).padStart(2)}.\` **${p.match_cost.toFixed(2)}** ${p.username} *(${p.maps_played}/${total_games} maps, avg ${p.avg_score.toLocaleString()})*`
                    ).join('\n');

                    embed.description = list || 'No scores found.';
                }

                resolve({ embeds: [embed] });

            } catch (err) {
                helper.error(err);
                if (err.response && err.response.status === 404)
                    reject(`Match #${match_id} not found.`);
                else if (err.response && err.response.status === 401)
                    reject(`Match #${match_id} is private.`);
                else
                    reject(`Couldn't fetch match: **${err.message || err}**`);
            }
        });
    }
};
