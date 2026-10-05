const osu = require('../osu.js');
const helper = require('../helper.js');

/**
 * One osu! player row of the server leaderboard.
 *
 * @typedef {Object} LeaderboardEntry
 * @property {string} ign
 * @property {number} pp
 * @property {number|null} global_rank
 */

// Promisified wrapper over the callback-style domain function (osu.js keeps
// its error-first callbacks; new code is async/await).
function getUserStats(ign){
    return new Promise((resolve, reject) => {
        osu.get_user_stats({ u: ign }, (err, stats) => {
            if(err)
                reject(err);
            else
                resolve(stats);
        });
    });
}

// Intersect the read-only user_ign map with the guild's current members and
// query the stats of every linked player present, one at a time. Unresolvable
// IGNs are skipped without aborting; duplicate osu! accounts keep the first
// link; empty links are discarded.
// @returns {Promise<LeaderboardEntry[]>}
async function collectEntries(user_ign, guild){
    const members = await guild.members.fetch();

    let entries = [];
    let seen_ids = new Set();

    for(const [user_id, ign] of Object.entries(user_ign)){
        if(!members.has(user_id))
            continue;

        if(typeof ign != 'string' || ign.trim().length == 0)
            continue;

        const stats = await getUserStats(ign);

        if(!stats)
            continue;

        if(seen_ids.has(stats.id))
            continue;

        seen_ids.add(stats.id);
        entries.push({ ign: stats.username, pp: stats.pp, global_rank: stats.global_rank });
    }

    return entries;
}

module.exports = {
    command: ['lb', 'leaderboard'],
    description: "Show a leaderboard of every linked osu! player in this server.",
    argsRequired: 0,
    usage: '(no arguments)',
    example: {
        run: "lb",
        result: "Returns the osu! leaderboard of the linked players in this server."
    },
    configRequired: ["credentials.client_id", "credentials.client_secret"],
    call: obj => {
        return new Promise((resolve, reject) => {
            (async () => {
                let { msg, user_ign } = obj;

                // guild-only guard: the guide resolves directly, nothing is sent (Req 1.2)
                if(!msg.guild){
                    resolve('This command can only be used in a server.');
                    return;
                }

                // immediate feedback before the N sequential stats queries (Req 1.1);
                // the result is always edited onto this single message
                const placeholder = await msg.channel.send('Building leaderboard… 🔄');

                let entries;
                try {
                    entries = await collectEntries(user_ign, msg.guild);
                } catch(err){
                    // osu! network/API failure or members.fetch failure: drop the
                    // placeholder so the standard error handling answers (Req 6.1)
                    await placeholder.delete().catch(() => {});
                    reject(err);
                    return;
                }

                // no linked players present: point at ;ign-set (Req 2.4)
                if(entries.length == 0){
                    await placeholder.edit('No osu! players linked in this server yet. Link yours with **;ign-set <username>**.');
                    resolve(null); // lb.js owns its message: index.js sends nothing
                    return;
                }

                // interim plain listing — task 2.2 replaces this seam with
                // sortEntries/buildPages/buildEmbed (no sorting guarantees yet)
                const lines = entries.map((entry, index) => `${index + 1}. ${entry.ign} — ${entry.pp}pp`);
                await placeholder.edit(lines.join('\n'));
                resolve(null);
            })().catch(reject);
        });
    }
};
